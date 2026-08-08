// src/backend/anthropic-call.ts
//
// Retry wrapper around @anthropic-ai/sdk. Translated from the private Python
// backend's services/_anthropic.py, minus the OTel/Firestore layer.
//
// Responsibilities:
//   1. Exponential backoff + jitter on transient errors (429/5xx/529).
//      529 (overloaded) uses wider jitter to de-sync parallel clients.
//   2. Consecutive-529 tracking per session — after N failures on the primary
//      model, swap to the backup model for the remaining retries.
//   3. Task-to-model mapping so callers pass "triage" | "generate" | "verify"
//      | "fallback_generate" instead of raw model ids.
//   4. Fire one trace record per call via trace-forwarder — metadata only.

import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages.mjs";
import { forwardTrace } from "./trace-forwarder.js";
import { sha256 } from "../utils/hash.js";

// -----------------------------------------------------------------------------
// Task → model mapping
// -----------------------------------------------------------------------------

export type Task = "triage" | "generate" | "verify" | "fallback_generate";

const MODEL_FOR: Record<Task, string> = {
  triage: "claude-haiku-4-5-20251001",
  generate: "claude-sonnet-4-5-20250929",
  verify: "claude-sonnet-4-5-20250929",
  fallback_generate: "claude-haiku-4-5-20251001",
};

const MAX_TOKENS_FOR: Record<Task, number> = {
  triage: 4096,
  generate: 8192,
  verify: 8192,
  fallback_generate: 4096,
};

const ANTHROPIC_MAX_RETRIES = 3;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 20_000;
const MAX_CONSECUTIVE_529 = 3;

// -----------------------------------------------------------------------------
// Per-session state (consecutive-529 tracking)
// -----------------------------------------------------------------------------

interface SessionState {
  consecutive_529: number;
  forced_fallback: boolean;
}

const _sessionStates = new Map<string, SessionState>();

function getSessionState(sessionId: string): SessionState {
  let s = _sessionStates.get(sessionId);
  if (!s) {
    s = { consecutive_529: 0, forced_fallback: false };
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

function addUsage(totals: TokenTotals, msg: Message, model: string): void {
  const u = msg.usage;
  if (!u) return;
  totals.input_tokens += u.input_tokens ?? 0;
  totals.output_tokens += u.output_tokens ?? 0;
  totals.cache_read_input_tokens += (u as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  totals.cache_creation_input_tokens += (u as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
  totals.last_model = model;
  totals.call_count += 1;
}

// -----------------------------------------------------------------------------
// Retry classification
// -----------------------------------------------------------------------------

function isRetriable(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  const s = err.status;
  if (s === undefined) return err instanceof Anthropic.APIConnectionError;
  if (s === 429) return true;
  if (s >= 500 && s < 600) return true;
  return false;
}

function isOverloaded(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  if (err.status === 529) return true;
  const body = (err as { error?: { error?: { type?: string } } }).error;
  return body?.error?.type === "overloaded_error";
}

function isPromptTooLong(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  return err.message.toLowerCase().includes("prompt is too long");
}

function retryAfterSeconds(err: unknown): number | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const headers = (err as { headers?: Record<string, string> }).headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function computeDelay(attempt: number, err: unknown): number {
  const ra = retryAfterSeconds(err);
  if (ra !== null) return Math.min(ra, RETRY_MAX_MS / 1000);

  const base = RETRY_BASE_MS / 1000;
  const max = RETRY_MAX_MS / 1000;
  const exp = Math.min(base * Math.pow(2, attempt - 1), max);
  const jitterPct = isOverloaded(err) ? 0.6 : 0.25;
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

export interface CallOptions {
  client: Anthropic;
  task: Task;
  sessionId: string;
  system?: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: MessageParam[];
  tools?: unknown[];
  toolChoice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
  temperature?: number;
  model?: string;
  maxTokens?: number;
  onStatus?: (stage: string, msg: string, progress: number) => Promise<void> | void;
  totals?: TokenTotals;
  cliVersion?: string;
  installationId?: string;
}

export async function call(opts: CallOptions): Promise<Message> {
  const session = getSessionState(opts.sessionId);

  // Effective task: session-wide fallback swaps generate/verify → fallback_generate
  const effectiveTask: Task =
    session.forced_fallback && (opts.task === "generate" || opts.task === "verify")
      ? "fallback_generate"
      : opts.task;

  let resolvedModel = opts.model ?? MODEL_FOR[effectiveTask];
  const resolvedMaxTokens = opts.maxTokens ?? MAX_TOKENS_FOR[effectiveTask];

  const maxAttempts = ANTHROPIC_MAX_RETRIES + 1;
  let lastErr: unknown = null;

  const promptHash = opts.system
    ? sha256(typeof opts.system === "string" ? opts.system : JSON.stringify(opts.system))
    : "";
  const responseSchema =
    opts.toolChoice && "name" in opts.toolChoice ? opts.toolChoice.name : "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const params: Parameters<Anthropic["messages"]["create"]>[0] = {
        model: resolvedModel,
        max_tokens: resolvedMaxTokens,
        temperature: opts.temperature ?? 0,
        messages: opts.messages,
      };
      if (opts.system !== undefined) params.system = opts.system as never;
      if (opts.tools !== undefined) params.tools = opts.tools as never;
      if (opts.toolChoice !== undefined) params.tool_choice = opts.toolChoice as never;

      const msg = (await opts.client.messages.create(params)) as Message;

      // Success — clear 529 counter, accumulate tokens, forward trace.
      session.consecutive_529 = 0;
      if (opts.totals) addUsage(opts.totals, msg, resolvedModel);

      void forwardTrace({
        installation_id: opts.installationId ?? "",
        mode: "local",
        cli_version: opts.cliVersion ?? "",
        session_id: opts.sessionId,
        stage: opts.task,
        model: resolvedModel,
        input_tokens: msg.usage?.input_tokens ?? 0,
        output_tokens: msg.usage?.output_tokens ?? 0,
        duration_ms: Date.now() - started,
        attempt,
        success: true,
        error_class: null,
        prompt_hash: promptHash,
        response_schema: responseSchema,
      });

      return msg;
    } catch (err) {
      if (isPromptTooLong(err)) {
        throw new PromptTooLongError(String((err as Error).message));
      }

      const retriable = isRetriable(err);
      if (!retriable) {
        void forwardTrace({
          installation_id: opts.installationId ?? "",
          mode: "local",
          cli_version: opts.cliVersion ?? "",
          session_id: opts.sessionId,
          stage: opts.task,
          model: resolvedModel,
          input_tokens: 0,
          output_tokens: 0,
          duration_ms: Date.now() - started,
          attempt,
          success: false,
          error_class: (err as Error).constructor.name,
          prompt_hash: promptHash,
          response_schema: responseSchema,
        });
        throw err;
      }

      lastErr = err;

      if (isOverloaded(err)) {
        session.consecutive_529 += 1;
        if (
          session.consecutive_529 >= MAX_CONSECUTIVE_529 &&
          !session.forced_fallback &&
          (effectiveTask === "generate" || effectiveTask === "verify")
        ) {
          session.forced_fallback = true;
          resolvedModel = MODEL_FOR.fallback_generate;
          if (opts.onStatus) {
            try {
              await opts.onStatus(
                "retrying",
                "Network congested — retrying on backup model",
                0.5,
              );
            } catch {
              // ignore
            }
          }
        }
      }

      if (attempt >= maxAttempts) {
        void forwardTrace({
          installation_id: opts.installationId ?? "",
          mode: "local",
          cli_version: opts.cliVersion ?? "",
          session_id: opts.sessionId,
          stage: opts.task,
          model: resolvedModel,
          input_tokens: 0,
          output_tokens: 0,
          duration_ms: Date.now() - started,
          attempt,
          success: false,
          error_class: (err as Error).constructor.name,
          prompt_hash: promptHash,
          response_schema: responseSchema,
        });
        throw err;
      }

      const delaySec = computeDelay(attempt, err);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }

  throw lastErr ?? new Error("anthropic-call: retries exhausted");
}

// -----------------------------------------------------------------------------
// Extract a single tool_use block by name — matches the Python helper.
// -----------------------------------------------------------------------------

export function extractToolUse(
  msg: Message,
  toolName: string,
): Record<string, unknown> | null {
  for (const block of msg.content) {
    if (block.type === "tool_use" && (block as ToolUseBlock).name === toolName) {
      return ((block as ToolUseBlock).input as Record<string, unknown>) ?? {};
    }
  }
  return null;
}
