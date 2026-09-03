// src/providers/anthropic.ts
//
// Anthropic adapter. Keeps the @anthropic-ai/sdk dependency and the native
// Messages API so the default path is byte-for-byte what it was before
// multi-provider support landed: same forced tool_use, same ephemeral prompt
// caching on the system prefix (worth real money on the classifier fan-out,
// and no OpenAI-shaped provider exposes an equivalent).

import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.mjs";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderId,
  Task,
} from "./types.js";
import { LlmError } from "./types.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string | null;
  models: Record<Task, string>;
}

type AnthropicApiError = InstanceType<typeof Anthropic.APIError>;

function isOverloaded(err: AnthropicApiError): boolean {
  if (err.status === 529) return true;
  const body = (err as { error?: { error?: { type?: string } } }).error;
  return body?.error?.type === "overloaded_error";
}

function retryAfterSeconds(err: AnthropicApiError): number | undefined {
  const headers = (err as { headers?: Record<string, string> }).headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof Anthropic.APIError) {
    const promptTooLong =
      err instanceof Anthropic.BadRequestError &&
      err.message.toLowerCase().includes("prompt is too long");
    return new LlmError(`Anthropic: ${err.message}`, {
      status: err.status,
      retryAfterSeconds: retryAfterSeconds(err),
      overloaded: isOverloaded(err),
      promptTooLong,
      connection: err instanceof Anthropic.APIConnectionError,
      cause: err,
    });
  }
  return new LlmError(`Anthropic: ${(err as Error).message ?? String(err)}`, {
    cause: err,
  });
}

export class AnthropicProvider implements LlmProvider {
  readonly id: ProviderId = "anthropic";
  readonly label = "Anthropic";
  private readonly client: Anthropic;
  private readonly models: Record<Task, string>;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      // backend/llm-call.ts owns retries: backoff, jitter, and the session-wide
      // swap to the backup model on repeated overloads. The SDK defaults to 2
      // retries of its own, which would multiply delays and make the `attempt`
      // number in trace records wrong. One policy, in one place.
      maxRetries: 0,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
    this.models = opts.models;
  }

  modelFor(task: Task): string {
    return this.models[task];
  }

  async send(req: LlmRequest): Promise<LlmResponse> {
    const system = req.system.map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));

    const messages: MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let msg: Message;
    try {
      msg = (await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: system as never,
        messages,
        tools: [
          {
            name: req.tool.name,
            description: req.tool.description,
            input_schema: req.tool.parameters,
          },
        ] as never,
        tool_choice: { type: "tool", name: req.tool.name } as never,
      })) as Message;
    } catch (e) {
      throw toLlmError(e);
    }

    let toolInput: Record<string, unknown> | null = null;
    for (const block of msg.content) {
      if (block.type === "tool_use" && (block as ToolUseBlock).name === req.tool.name) {
        toolInput = ((block as ToolUseBlock).input as Record<string, unknown>) ?? {};
        break;
      }
    }

    const u = msg.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        }
      | undefined;

    return {
      toolInput,
      model: msg.model || req.model,
      usage: {
        input_tokens: u?.input_tokens ?? 0,
        output_tokens: u?.output_tokens ?? 0,
        cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
