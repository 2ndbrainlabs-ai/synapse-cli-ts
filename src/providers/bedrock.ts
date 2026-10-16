// src/providers/bedrock.ts
//
// Amazon Bedrock adapter, via the Converse API — one request shape for every
// Bedrock model family (Claude, Nova, Llama, Mistral, …), so there is one
// adapter rather than one per vendor.
//
// AUTH: never takes a key from Synapse. The AWS SDK's default credential chain
// does it, exactly as the AWS CLI would: AWS_ACCESS_KEY_ID/SECRET env, a named
// profile (AWS_PROFILE or `synapse model set bedrock --profile`), SSO sessions
// from `aws sso login`, or a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK.
// Nothing AWS-related is ever written to .synapse/config.json.
//
// LOADING: @aws-sdk/client-bedrock-runtime is imported lazily on first call,
// so users who never pick Bedrock don't pay its load time. It needs Node >= 20.
//
// STRUCTURED OUTPUT: Converse supports forcing a named tool for Claude, Nova
// and Mistral. Other families only accept toolChoice "auto", so for those the
// schema also travels in the system prompt and a JSON reply is accepted —
// the same fallback the OpenAI-compatible adapter uses for Ollama.

import { extractJsonObject } from "./openai-compat.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderId,
  Task,
} from "./types.js";
import { LlmError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;

function requestTimeoutMs(): number {
  const raw = Number((process.env.SYNAPSE_LLM_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export interface BedrockProviderOptions {
  region: string;
  /** Named AWS profile. Unset means the SDK's normal resolution (AWS_PROFILE, default). */
  profile?: string | null;
  /** Custom endpoint, e.g. a VPC interface endpoint. Unset means the regional default. */
  endpoint?: string | null;
  models: Record<Task, string>;
}

/** Families whose Converse implementation honours toolChoice {tool: {name}}. */
export function bedrockSupportsForcedTool(modelId: string): boolean {
  return /(^|\.)(anthropic\.claude|amazon\.nova|mistral\.)/.test(modelId);
}

/** Families that support Converse cachePoint blocks on the system prompt. */
export function bedrockSupportsCache(modelId: string): boolean {
  return /(^|\.)(anthropic\.claude|amazon\.nova)/.test(modelId);
}

interface AwsLikeError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  $retryable?: unknown;
  code?: string;
}

/** Translate AWS SDK errors into the provider-neutral LlmError. Exported for tests. */
export function bedrockError(err: unknown, modelId: string): LlmError {
  const e = (err ?? {}) as AwsLikeError;
  const name = e.name ?? "";
  const msg = e.message ?? String(err);
  const status = e.$metadata?.httpStatusCode;

  if (name === "CredentialsProviderError" || /could not load credentials/i.test(msg)) {
    return new LlmError(
      "Bedrock: no AWS credentials found. Run `aws configure` or `aws sso login`, " +
        "set AWS_PROFILE, or set AWS_BEARER_TOKEN_BEDROCK to a Bedrock API key.",
      { cause: err },
    );
  }
  if (name === "AccessDeniedException") {
    return new LlmError(
      `Bedrock: access denied for ${modelId}. Enable model access for it in the Bedrock ` +
        `console (Model access) for this region, and check the IAM policy allows ` +
        `bedrock:InvokeModel. (${msg})`,
      { status: status ?? 403, cause: err },
    );
  }
  if (name === "ResourceNotFoundException") {
    return new LlmError(
      `Bedrock: model ${modelId} not found in this region. Some models need a ` +
        `cross-region inference profile id (e.g. "us.anthropic..."). (${msg})`,
      { status: status ?? 404, cause: err },
    );
  }
  if (name === "ValidationException") {
    const tooLong = /too long|too many (input )?tokens|context (window|length)|maximum (context|input)/i.test(msg);
    return new LlmError(`Bedrock: ${msg}`, { status: status ?? 400, promptTooLong: tooLong, cause: err });
  }
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") {
    return new LlmError(`Bedrock: ${msg}`, { status: 429, cause: err });
  }
  if (name === "ServiceUnavailableException" || name === "ModelNotReadyException") {
    return new LlmError(`Bedrock: ${msg}`, { status: 503, overloaded: true, cause: err });
  }
  if (name === "ModelTimeoutException" || name === "TimeoutError" || name === "AbortError") {
    return new LlmError(`Bedrock: request timed out (${msg})`, { connection: true, cause: err });
  }
  if (!status && /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(`${e.code ?? ""} ${msg}`)) {
    return new LlmError(`Bedrock: network error (${msg})`, { connection: true, cause: err });
  }
  return new LlmError(`Bedrock: ${msg}`, { status, cause: err });
}

type BedrockModule = typeof import("@aws-sdk/client-bedrock-runtime");

export class BedrockProvider implements LlmProvider {
  readonly id: ProviderId = "bedrock";
  readonly label = "Amazon Bedrock";
  private readonly opts: BedrockProviderOptions;
  private client: InstanceType<BedrockModule["BedrockRuntimeClient"]> | null = null;
  private mod: BedrockModule | null = null;

  constructor(opts: BedrockProviderOptions) {
    this.opts = opts;
  }

  modelFor(task: Task): string {
    return this.opts.models[task];
  }

  private async sdk(): Promise<{ mod: BedrockModule; client: InstanceType<BedrockModule["BedrockRuntimeClient"]> }> {
    if (this.mod && this.client) return { mod: this.mod, client: this.client };
    let mod: BedrockModule;
    try {
      mod = await import("@aws-sdk/client-bedrock-runtime");
    } catch (e) {
      throw new LlmError(
        "Bedrock: could not load @aws-sdk/client-bedrock-runtime (requires Node 20+). " +
          `Running Node ${process.versions.node}.`,
        { cause: e },
      );
    }
    // backend/llm-call.ts owns retries (backoff, jitter, overload fallback), so
    // the SDK's own retry loop is turned off — one policy, in one place.
    const client = new mod.BedrockRuntimeClient({
      region: this.opts.region,
      maxAttempts: 1,
      ...(this.opts.profile ? { profile: this.opts.profile } : {}),
      ...(this.opts.endpoint ? { endpoint: this.opts.endpoint } : {}),
    });
    this.mod = mod;
    this.client = client;
    return { mod, client };
  }

  async send(req: LlmRequest): Promise<LlmResponse> {
    const { mod, client } = await this.sdk();
    const forced = bedrockSupportsForcedTool(req.model);
    const cache = bedrockSupportsCache(req.model);

    const system: Array<Record<string, unknown>> = [];
    for (const block of req.system) {
      system.push({ text: block.text });
      if (block.cache && cache) system.push({ cachePoint: { type: "default" } });
    }
    if (!forced) {
      system.push({
        text:
          `## REQUIRED OUTPUT\nCall the \`${req.tool.name}\` tool. If you cannot call tools, ` +
          `reply with ONLY a JSON object (no prose, no markdown fences) matching this JSON Schema:\n` +
          JSON.stringify(req.tool.parameters),
      });
    }

    const input = {
      modelId: req.model,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: req.maxTokens, temperature: req.temperature },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: req.tool.name,
              description: req.tool.description,
              inputSchema: { json: req.tool.parameters },
            },
          },
        ],
        toolChoice: forced ? { tool: { name: req.tool.name } } : { auto: {} },
      },
    };

    let out: {
      output?: { message?: { content?: Array<{ text?: string; toolUse?: { name?: string; input?: unknown } }> } };
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
    };
    try {
      out = (await client.send(new mod.ConverseCommand(input as never), {
        abortSignal: AbortSignal.timeout(requestTimeoutMs()) as never,
      })) as unknown as typeof out;
    } catch (e) {
      throw bedrockError(e, req.model);
    }

    const content = out.output?.message?.content ?? [];
    let toolInput: Record<string, unknown> | null = null;
    for (const block of content) {
      if (block.toolUse && block.toolUse.name === req.tool.name) {
        const v = block.toolUse.input;
        toolInput = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
        break;
      }
    }
    if (!toolInput) {
      const text = content.map((b) => b.text ?? "").join("\n");
      toolInput = extractJsonObject(text);
    }

    const u = out.usage ?? {};
    return {
      toolInput,
      model: req.model,
      usage: {
        input_tokens: u.inputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
        cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
        cache_creation_input_tokens: u.cacheWriteInputTokens ?? 0,
      },
    };
  }
}
