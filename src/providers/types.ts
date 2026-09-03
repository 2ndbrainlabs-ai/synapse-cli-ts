// src/providers/types.ts
//
// Provider-neutral LLM types.
//
// The entire local codegen backend makes exactly one shape of LLM call:
// "given a system prompt and a conversation, emit one call to THIS tool with
// arguments matching THIS JSON Schema". Every stage (classify, shape, name,
// repair) is that call and nothing else. So the neutral surface is deliberately
// narrow — one forced tool call in, parsed arguments out. Anything a provider
// can't do natively (Ollama has no tool_choice) is emulated inside its adapter
// rather than leaking a capability flag into callers.

/** Provider families the CLI can drive in --local mode. */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "groq"
  | "grok"
  | "openrouter"
  | "ollama"
  | "custom";

/** Logical stage of the codegen pipeline. Maps to a model per provider. */
export type Task = "triage" | "generate" | "verify" | "fallback_generate";

/**
 * A system-prompt segment. `cache` marks it as a stable prefix worth caching;
 * providers that support prompt caching honour it, the rest ignore it.
 */
export interface LlmSystemBlock {
  text: string;
  cache?: boolean;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** A tool the model is required to call. `parameters` is a JSON Schema object. */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface LlmRequest {
  model: string;
  maxTokens: number;
  temperature: number;
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  /** Exactly one tool, and the model is forced (or coerced) into calling it. */
  tool: LlmTool;
}

export interface LlmResponse {
  /** Parsed arguments of the forced tool call; null if the model produced none. */
  toolInput: Record<string, unknown> | null;
  usage: LlmUsage;
  /** Model actually used, as reported by the provider (falls back to requested). */
  model: string;
}

/**
 * Normalised transport error. Adapters translate their native error shapes into
 * this so the retry policy in backend/llm-call.ts stays provider-agnostic.
 */
export class LlmError extends Error {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  /** Provider is shedding load (Anthropic 529, or an explicit overloaded body). */
  readonly overloaded: boolean;
  /** Context window exceeded — never retryable, callers shrink the prompt. */
  readonly promptTooLong: boolean;
  /** Network-level failure with no HTTP status. */
  readonly connection: boolean;

  constructor(
    message: string,
    opts: {
      status?: number;
      retryAfterSeconds?: number;
      overloaded?: boolean;
      promptTooLong?: boolean;
      connection?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.overloaded = opts.overloaded ?? false;
    this.promptTooLong = opts.promptTooLong ?? false;
    this.connection = opts.connection ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export interface LlmProvider {
  readonly id: ProviderId;
  /** Human label for UI ("Groq", "Ollama (local)"). */
  readonly label: string;
  /** Resolve the model id for a pipeline stage. */
  modelFor(task: Task): string;
  send(req: LlmRequest): Promise<LlmResponse>;
}
