// src/backend/llm-call.ts
//
// Retry + fallback policy for local-mode LLM calls. Provider-agnostic: the
// transport lives in src/providers/, this file owns "what to do when it fails".
// Replaces the former anthropic-call.ts, which coupled the same policy to
// @anthropic-ai/sdk error classes.
//
// Responsibilities:
//   1. Exponential backoff + jitter on transient errors (429/5xx/529).
//      Overload responses use wider jitter to de-sync parallel clients.
//   2. Consecutive-overload tracking per session — after N failures on the
//      primary model, swap to the provider's backup model for the remainder.
//   3. Task-to-model mapping delegated to the provider, so callers pass
//      "triage" | "generate" | "verify" | "fallback_generate" and never a
//      provider-specific model id.
//   4. One trace record per call via trace-forwarder — metadata only.
//
// Every stage of the codegen pipeline is a single forced tool call, so this
// module returns the parsed tool arguments directly. There is no provider
// message type in the callers' signatures, which is what lets the same
// classify/shape/name/repair code run on Anthropic, OpenAI, Groq, xAI,
// OpenRouter, Ollama or a self-hosted endpoint unchanged.

import { forwardTrace } from "./trace-forwarder.js";
import { sha256 } from "../utils/hash.js";
import { LlmError } from "../providers/types.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmSystemBlock,
  LlmTool,
  Task,
} from "../providers/types.js";

export type { Task, LlmMessage, LlmSystemBlock, LlmTool } from "../providers/types.js";

const MAX_TOKENS_FOR: Record<Task, number> = {
  triage: 4096,
  generate: 8192,
  verify: 8192,
  fallback_generate: 4096,
};

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 20_000;
const MAX_CONSECUTIVE_OVERLOADS = 3;

// -----------------------------------------------------------------------------
// Per-session state (consecutive-overload tracking)
// -----------------------------------------------------------------------------

interface SessionState {
  consecutive_overloads: number;
  forced_fallback: boolean;
}

const _sessionStates = new Map<string, SessionState>();

function getSessionState(sessionId: string): SessionState {
  let s = _sessionStates.get(sessionId);
  if (!s) {
    s = { consecutive_overloads: 0, forced_fallback: false };
    _sessionStates.set(sessionId, s);
  }
  return s;
}

// -----------------------------------------------------------------------------
// Token accumulator (per-call totals)
// -----------------------------------------------------------------------------

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  last_model: string;
  call_count: number;
}

export function newTokenTotals(): TokenTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    last_model: "",
    call_count: 0,
  };
}

// -----------------------------------------------------------------------------
// Retry classification
// -----------------------------------------------------------------------------

function isRetriable(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false;
  if (err.promptTooLong) return false;
  if (err.connection) return true;
  const s = err.status;
  if (s === undefined) return false;
  if (s === 408 || s === 429) return true;
  return s >= 500 && s < 600;
}

function computeDelaySeconds(attempt: number, err: unknown): number {
  const retryAfter = err instanceof LlmError ? err.retryAfterSeconds : undefined;
  if (retryAfter !== undefined) {
    return Math.min(retryAfter, RETRY_MAX_MS / 1000);
  }

  const base = RETRY_BASE_MS / 1000;
  const max = RETRY_MAX_MS / 1000;
  const exp = Math.min(base * Math.pow(2, attempt - 1), max);
  const overloaded = err instanceof LlmError && err.overloaded;
  const jitterPct = overloaded ? 0.6 : 0.25;
  const jitter = exp * jitterPct * (2 * Math.random() - 1);
  return Math.max(0.05, exp + jitter);
}

export class PromptTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTooLongError";
  }
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export interface CallToolOptions {
  provider: LlmProvider;
  task: Task;
  sessionId: string;
  /** Plain string, or blocks so a stable prefix can be marked cacheable. */
  system?: string | LlmSystemBlock[];
  messages: LlmMessage[];
  /** The single tool the model is required to call. */
  tool: LlmTool;
  temperature?: number;
  /** Override the provider's model for this task. */
  model?: string;
  maxTokens?: number;
  onStatus?: (stage: string, msg: string, progress: number) => Promise<void> | void;
  totals?: TokenTotals;
  cliVersion?: string;
  installationId?: string;
}

function normaliseSystem(
  system: string | LlmSystemBlock[] | undefined,
): LlmSystemBlock[] {
  if (system === undefined) return [];
  if (typeof system === "string") return system ? [{ text: system }] : [];
  return system;
}

/**
 * Run one forced tool call with retries. Returns the parsed tool arguments,
 * or null when the model answered but produced nothing schema-shaped — callers
 * already treat that as a soft failure and retry with feedback or fall back to
 * a default, which matters more now that weaker models are reachable.
 *
 * Throws PromptTooLongError when the context window is exceeded (callers shrink
 * and retry) and LlmError for transport failures that survived retries.
 */
export async function callTool(
  opts: CallToolOptions,
): Promise<Record<string, unknown> | null> {
  const session = getSessionState(opts.sessionId);

  // Session-wide degradation: repeated overloads on the primary model swap
  // generate/verify down to the provider's backup model.
  const effectiveTask: Task =
    session.forced_fallback && (opts.task === "generate" || opts.task === "verify")
      ? "fallback_generate"
      : opts.task;

  let resolvedModel = opts.model ?? opts.provider.modelFor(effectiveTask);
  const resolvedMaxTokens = opts.maxTokens ?? MAX_TOKENS_FOR[effectiveTask];
  const system = normaliseSystem(opts.system);

  const promptHash = system.length
    ? sha256(system.map((b) => b.text).join("\n\n"))
    : "";

  const maxAttempts = MAX_RETRIES + 1;
  let lastErr: unknown = null;

  const trace = (
    started: number,
    attempt: number,
    success: boolean,
    errorClass: string | null,
    inputTokens = 0,
    outputTokens = 0,
  ): void => {
    void forwardTrace({
      installation_id: opts.installationId ?? "",
      mode: "local",
      cli_version: opts.cliVersion ?? "",
      session_id: opts.sessionId,
      stage: opts.task,
      model: resolvedModel,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: Date.now() - started,
      attempt,
      success,
      error_class: errorClass,
      prompt_hash: promptHash,
      response_schema: opts.tool.name,
    });
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const res = await opts.provider.send({
        model: resolvedModel,
        maxTokens: resolvedMaxTokens,
        temperature: opts.temperature ?? 0,
        system,
        messages: opts.messages,
        tool: opts.tool,
      });

      session.consecutive_overloads = 0;

      if (opts.totals) {
        opts.totals.input_tokens += res.usage.input_tokens;
        opts.totals.output_tokens += res.usage.output_tokens;
        opts.totals.cache_read_input_tokens += res.usage.cache_read_input_tokens;
        opts.totals.cache_creation_input_tokens += res.usage.cache_creation_input_tokens;
        opts.totals.last_model = res.model;
        opts.totals.call_count += 1;
      }

      trace(
        started,
        attempt,
        true,
        null,
        res.usage.input_tokens,
        res.usage.output_tokens,
      );

      return res.toolInput;
    } catch (err) {
      if (err instanceof LlmError && err.promptTooLong) {
        throw new PromptTooLongError(err.message);
      }

      if (!isRetriable(err)) {
        trace(started, attempt, false, (err as Error).constructor.name);
        throw err;
      }

      lastErr = err;

      if (err instanceof LlmError && err.overloaded) {
        session.consecutive_overloads += 1;
        if (
          session.consecutive_overloads >= MAX_CONSECUTIVE_OVERLOADS &&
          !session.forced_fallback &&
          (effectiveTask === "generate" || effectiveTask === "verify")
        ) {
          session.forced_fallback = true;
          resolvedModel = opts.provider.modelFor("fallback_generate");
          if (opts.onStatus) {
            try {
              await opts.onStatus(
                "retrying",
                "Provider congested — retrying on backup model",
                0.5,
              );
            } catch {
              // status reporting must never break the call
            }
          }
        }
      }

      if (attempt >= maxAttempts) {
        trace(started, attempt, false, (err as Error).constructor.name);
        throw err;
      }

      await new Promise((r) =>
        setTimeout(r, computeDelaySeconds(attempt, err) * 1000),
      );
    }
  }

  throw lastErr ?? new Error("llm-call: retries exhausted");
}
