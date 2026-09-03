// src/providers/openai-compat.ts
//
// One adapter for every OpenAI-shaped endpoint: OpenAI, Groq, xAI (Grok),
// OpenRouter, Ollama, and any user-supplied URL. They differ only in base URL,
// auth header, model ids and a few capability flags (see catalog.ts) — the
// request and response bodies are the same contract, so there is one
// implementation rather than six.
//
// Uses global fetch (Node >= 18, matching package.json engines) instead of the
// `openai` SDK: the call is a single non-streaming POST, retry/backoff already
// lives in backend/llm-call.ts, and no new dependency means a custom endpoint
// works with nothing but a URL.
//
// STRUCTURED OUTPUT
// The backend needs one forced tool call. Two paths, because `tool_choice` is
// not universal — Ollama documents it as unsupported and some self-hosted
// servers ignore it:
//   caps.toolChoice  → send tools + tool_choice pinned to the function name.
//   !caps.toolChoice → send tools, plus JSON mode and a schema instruction in
//                      the system prompt.
// Extraction accepts either outcome regardless of which path was requested, so
// a provider that silently ignores tool_choice still works.

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderId,
  Task,
} from "./types.js";
import { LlmError } from "./types.js";
import type { ProviderCaps } from "./catalog.js";

const DEFAULT_TIMEOUT_MS = 300_000;

function requestTimeoutMs(): number {
  const raw = Number((process.env.SYNAPSE_LLM_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export interface OpenAICompatOptions {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  caps: ProviderCaps;
  models: Record<Task, string>;
  headers?: Record<string, string>;
}

// -----------------------------------------------------------------------------
// Response shapes — only the fields we read.
// -----------------------------------------------------------------------------

interface ChatToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string };
}

// -----------------------------------------------------------------------------
// Structured-output extraction
// -----------------------------------------------------------------------------

/**
 * Pull the first balanced JSON object out of free text, tolerating markdown
 * fences and prose on either side. Brace counting is string-aware so a `}`
 * inside a generated Python body doesn't truncate the object — that body is
 * the single largest field the backend asks for, so naive matching corrupts it.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function coerceArguments(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // Some models emit arguments wrapped in prose or fences.
      return extractJsonObject(trimmed);
    }
  }
  return null;
}

function extractToolInput(
  body: ChatResponse,
  toolName: string,
): Record<string, unknown> | null {
  const message = body.choices?.[0]?.message;
  if (!message) return null;

  const calls = message.tool_calls ?? [];
  // Prefer the requested tool; fall back to the sole call if the model renamed
  // it (small local models do this).
  const match =
    calls.find((c) => c.function?.name === toolName) ??
    (calls.length === 1 ? calls[0] : undefined);
  if (match) {
    const args = coerceArguments(match.function?.arguments);
    if (args) return args;
  }

  // JSON-mode path, or a provider that ignored tool_choice.
  if (typeof message.content === "string" && message.content.trim()) {
    return extractJsonObject(message.content);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Error normalisation
// -----------------------------------------------------------------------------

const CONTEXT_OVERFLOW_MARKERS = [
  "context length",
  "context_length_exceeded",
  "maximum context",
  "context window",
  "reduce the length",
  "too many tokens",
  "prompt is too long",
  "string too long",
];

function looksLikeContextOverflow(message: string): boolean {
  const m = message.toLowerCase();
  return CONTEXT_OVERFLOW_MARKERS.some((marker) => m.includes(marker));
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

export class OpenAICompatProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  private readonly endpoint: string;
  private readonly apiKey: string | null;
  private readonly caps: ProviderCaps;
  private readonly models: Record<Task, string>;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = opts.apiKey;
    this.caps = opts.caps;
    this.models = opts.models;
    this.extraHeaders = opts.headers ?? {};
  }

  modelFor(task: Task): string {
    return this.models[task];
  }

  async send(req: LlmRequest): Promise<LlmResponse> {
    const systemText = req.system.map((b) => b.text).join("\n\n");
    const forcing = this.caps.toolChoice;

    // Without tool_choice the schema has to travel in the prompt, otherwise the
    // model has no signal that a specific shape is required.
    const systemContent = forcing
      ? systemText
      : `${systemText}\n\n` +
        `## REQUIRED OUTPUT\n` +
        `Call the \`${req.tool.name}\` function. If you cannot call functions, ` +
        `reply with ONLY a JSON object (no prose, no markdown fences) matching ` +
        `this JSON Schema:\n${JSON.stringify(req.tool.parameters)}`;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        ...(systemContent ? [{ role: "system", content: systemContent }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      tools: [
        {
          type: "function",
          function: {
            name: req.tool.name,
            description: req.tool.description,
            parameters: req.tool.parameters,
          },
        },
      ],
      stream: false,
    };

    body[this.caps.maxTokensField] = req.maxTokens;
    if (this.caps.temperature) body.temperature = req.temperature;

    if (forcing) {
      body.tool_choice = {
        type: "function",
        function: { name: req.tool.name },
      };
    } else {
      body.response_format = { type: "json_object" };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs()),
      });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      throw new LlmError(
        `${this.label}: could not reach ${this.endpoint} (${msg})`,
        { connection: true, cause: e },
      );
    }

    const rawText = await res.text();

    if (!res.ok) {
      let detail = rawText.slice(0, 600);
      try {
        const parsed = JSON.parse(rawText) as ChatResponse;
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep the raw snippet
      }
      throw new LlmError(`${this.label} ${res.status}: ${detail}`, {
        status: res.status,
        retryAfterSeconds: parseRetryAfter(res.headers),
        overloaded: res.status === 529 || res.status === 503,
        promptTooLong: res.status === 400 && looksLikeContextOverflow(detail),
      });
    }

    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(rawText) as ChatResponse;
    } catch {
      throw new LlmError(
        `${this.label}: response was not JSON. ` +
          `Check that ${this.endpoint} is an OpenAI-compatible endpoint. ` +
          `Got: ${rawText.slice(0, 200)}`,
      );
    }

    // Some gateways return 200 with an error body.
    if (parsed.error?.message) {
      throw new LlmError(`${this.label}: ${parsed.error.message}`, {
        promptTooLong: looksLikeContextOverflow(parsed.error.message),
      });
    }

    const promptTokens = parsed.usage?.prompt_tokens ?? 0;
    const cached = parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      toolInput: extractToolInput(parsed, req.tool.name),
      model: parsed.model || req.model,
      usage: {
        // Report uncached prompt tokens under input_tokens so totals across
        // providers stay comparable with Anthropic's split accounting.
        input_tokens: Math.max(0, promptTokens - cached),
        output_tokens: parsed.usage?.completion_tokens ?? 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      },
    };
  }
}

export const __test = { extractJsonObject, extractToolInput, coerceArguments };
