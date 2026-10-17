// src/providers/vertex.ts
//
// Google Cloud Vertex AI adapter. Vertex serves two model families through two
// different APIs, so this provider routes each request by model id:
//
//   claude-*   → Anthropic Messages API on Vertex (:rawPredict). Same request
//                body as the Anthropic adapter, so forced tool_use and prompt
//                caching behave identically to the direct Anthropic path.
//   anything   → Vertex's OpenAI-compatible endpoint (Gemini and Model Garden
//   else         models), reusing the OpenAI-compatible adapter.
//
// Routing is per request because stages can mix families, e.g. a cheap Gemini
// Flash for triage and Claude Sonnet for generation.
//
// Called with fetch rather than @anthropic-ai/vertex-sdk on purpose: that
// package requires a much newer @anthropic-ai/sdk than this CLI pins, and the
// upgrade would put the default Anthropic path at risk for no gain.
//
// AUTH: Google Application Default Credentials — `gcloud auth application-default
// login`, GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account key, or
// the attached service account when running on GCP. google-auth-library is
// imported lazily and caches/refreshes the hourly access token itself.

import { OpenAICompatProvider } from "./openai-compat.js";
import type { ProviderCaps } from "./catalog.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderId,
  Task,
} from "./types.js";
import { LlmError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const ANTHROPIC_VERTEX_VERSION = "vertex-2023-10-16";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function requestTimeoutMs(): number {
  const raw = Number((process.env.SYNAPSE_LLM_TIMEOUT_MS ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

export interface VertexProviderOptions {
  project: string;
  /** Vertex location, e.g. "global", "us-east5", "europe-west1". */
  region: string;
  models: Record<Task, string>;
  /** Injectable for tests; defaults to Google ADC. */
  tokenSource?: () => Promise<string>;
}

export function isClaudeModel(modelId: string): boolean {
  return /^claude[-_]/.test(modelId);
}

/** API host for a Vertex location. "global" has no regional prefix. */
export function vertexHost(region: string): string {
  return region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
}

export function vertexOpenAiBaseUrl(project: string, region: string): string {
  return `https://${vertexHost(region)}/v1/projects/${project}/locations/${region}/endpoints/openapi`;
}

export function vertexClaudeUrl(project: string, region: string, model: string): string {
  return (
    `https://${vertexHost(region)}/v1/projects/${project}/locations/${region}` +
    `/publishers/anthropic/models/${model}:rawPredict`
  );
}

/** Vertex's OpenAI endpoint names publisher models "publisher/model". */
export function openAiModelId(modelId: string): string {
  return modelId.includes("/") ? modelId : `google/${modelId}`;
}

function adcTokenSource(): () => Promise<string> {
  let auth: { getAccessToken(): Promise<string | null | undefined> } | null = null;
  return async () => {
    try {
      if (!auth) {
        const { GoogleAuth } = await import("google-auth-library");
        auth = new GoogleAuth({ scopes: [SCOPE] });
      }
      const token = await auth.getAccessToken();
      if (!token) throw new Error("empty access token");
      return token;
    } catch (e) {
      throw new LlmError(
        "Vertex AI: no Google credentials found. Run `gcloud auth application-default login`, " +
          "or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file. " +
          `(${(e as Error).message})`,
        { cause: e },
      );
    }
  };
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const GEMINI_CAPS: ProviderCaps = {
  toolChoice: true,
  maxTokensField: "max_tokens",
  temperature: true,
  promptCache: false,
};

export class VertexProvider implements LlmProvider {
  readonly id: ProviderId = "vertex";
  readonly label = "Google Vertex AI";
  private readonly opts: VertexProviderOptions;
  private readonly token: () => Promise<string>;
  private openai: OpenAICompatProvider | null = null;

  constructor(opts: VertexProviderOptions) {
    this.opts = opts;
    this.token = opts.tokenSource ?? adcTokenSource();
  }

  modelFor(task: Task): string {
    return this.opts.models[task];
  }

  send(req: LlmRequest): Promise<LlmResponse> {
    return isClaudeModel(req.model) ? this.sendClaude(req) : this.sendOpenAi(req);
  }

  private async sendOpenAi(req: LlmRequest): Promise<LlmResponse> {
    if (!this.openai) {
      this.openai = new OpenAICompatProvider({
        id: "vertex",
        label: "Vertex AI",
        baseUrl: vertexOpenAiBaseUrl(this.opts.project, this.opts.region),
        apiKey: null,
        caps: GEMINI_CAPS,
        models: this.opts.models,
        bearerToken: this.token,
      });
    }
    const res = await this.openai.send({ ...req, model: openAiModelId(req.model) });
    return { ...res, model: req.model };
  }

  private async sendClaude(req: LlmRequest): Promise<LlmResponse> {
    const url = vertexClaudeUrl(this.opts.project, this.opts.region, req.model);
    const body = {
      anthropic_version: ANTHROPIC_VERTEX_VERSION,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system.map((b) => ({
        type: "text",
        text: b.text,
        ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}),
      })),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.parameters }],
      tool_choice: { type: "tool", name: req.tool.name },
    };

    const token = await this.token();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs()),
      });
    } catch (e) {
      throw new LlmError(`Vertex AI: network error (${(e as Error).message})`, { connection: true, cause: e });
    }

    const text = await res.text();
    let parsed: {
      content?: Array<{ type?: string; name?: string; input?: unknown }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      error?: { message?: string; type?: string };
    } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON error page; handled below */
    }

    if (!res.ok) {
      const detail = parsed.error?.message ?? text.slice(0, 300);
      const hint =
        res.status === 401 || res.status === 403
          ? " Check the account has roles/aiplatform.user on the project and the Claude model is enabled in Model Garden."
          : res.status === 404
            ? " The model may not be available in this region; try --region global or us-east5."
            : "";
      throw new LlmError(`Vertex AI ${res.status}: ${detail}${hint}`, {
        status: res.status,
        retryAfterSeconds: parseRetryAfter(res.headers),
        overloaded: res.status === 529 || res.status === 503 || parsed.error?.type === "overloaded_error",
        promptTooLong: res.status === 400 && /prompt is too long|too many tokens/i.test(detail),
      });
    }

    let toolInput: Record<string, unknown> | null = null;
    for (const block of parsed.content ?? []) {
      if (block.type === "tool_use" && block.name === req.tool.name) {
        const v = block.input;
        toolInput = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
        break;
      }
    }

    const u = parsed.usage ?? {};
    return {
      toolInput,
      model: req.model,
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
