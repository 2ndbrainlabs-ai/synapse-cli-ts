// Vertex AI routes each request by model id: claude-* to the Anthropic
// Messages API on Vertex (:rawPredict), everything else to Vertex's
// OpenAI-compatible endpoint. Vertex hosts are fixed Google domains, so fetch
// is stubbed and the assertions are on the exact URLs, headers and bodies.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  VertexProvider,
  isClaudeModel,
  openAiModelId,
  vertexClaudeUrl,
  vertexOpenAiBaseUrl,
} from "../../../src/providers/vertex.js";
import { LlmError } from "../../../src/providers/types.js";
import type { LlmRequest, LlmTool, Task } from "../../../src/providers/types.js";

const TOOL: LlmTool = {
  name: "emit_plan",
  description: "Emit the plan",
  parameters: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
};

const MODELS: Record<Task, string> = {
  triage: "gemini-2.5-flash",
  generate: "claude-sonnet-4-5@20250929",
  verify: "claude-sonnet-4-5@20250929",
  fallback_generate: "gemini-2.5-flash",
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: () => Response;

function req(model: string): LlmRequest {
  return {
    model,
    maxTokens: 256,
    temperature: 0,
    system: [{ text: "STABLE", cache: true }, { text: "volatile" }],
    messages: [{ role: "user", content: "go" }],
    tool: TOOL,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const tokenSource = vi.fn(async () => "ya29.test-token");
const provider = (region = "global") =>
  new VertexProvider({ project: "my-proj", region, models: MODELS, tokenSource });

beforeEach(() => {
  calls = [];
  tokenSource.mockClear();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

const body = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;
const authOf = (c: Call) => (c.init.headers as Record<string, string>).Authorization;

describe("Claude on Vertex (rawPredict)", () => {
  beforeEach(() => {
    reply = () =>
      json(200, {
        content: [{ type: "tool_use", id: "t1", name: "emit_plan", input: { x: "ok" } }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 700, cache_creation_input_tokens: 30 },
      });
  });

  it("posts to the publisher rawPredict URL with an ADC bearer token", async () => {
    await provider().send(req("claude-sonnet-4-5@20250929"));
    expect(calls[0].url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict",
    );
    expect(authOf(calls[0])).toBe("Bearer ya29.test-token");
  });

  it("uses a regional host for a regional location", async () => {
    await provider("us-east5").send(req("claude-sonnet-4-5@20250929"));
    expect(calls[0].url.startsWith("https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/")).toBe(true);
  });

  it("sends the Anthropic body: vertex version, forced tool, cache_control on the stable prefix, no model field", async () => {
    await provider().send(req("claude-sonnet-4-5@20250929"));
    const b = body(calls[0]);
    expect(b.anthropic_version).toBe("vertex-2023-10-16");
    expect(b.model).toBeUndefined();
    expect(b.tool_choice).toEqual({ type: "tool", name: "emit_plan" });
    expect(b.tools).toEqual([{ name: "emit_plan", description: "Emit the plan", input_schema: TOOL.parameters }]);
    expect(b.system).toEqual([
      { type: "text", text: "STABLE", cache_control: { type: "ephemeral" } },
      { type: "text", text: "volatile" },
    ]);
  });

  it("returns tool input and usage including cache tokens", async () => {
    const res = await provider().send(req("claude-sonnet-4-5@20250929"));
    expect(res.toolInput).toEqual({ x: "ok" });
    expect(res.usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 700, cache_creation_input_tokens: 30 });
  });

  it("maps 429 to a retryable error with Retry-After", async () => {
    reply = () => json(429, { error: { message: "quota" } }, { "retry-after": "7" });
    const err = (await provider().send(req("claude-sonnet-4-5@20250929")).catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(7);
  });

  it("maps 529 to overloaded and an over-long prompt to promptTooLong", async () => {
    reply = () => json(529, { error: { type: "overloaded_error", message: "Overloaded" } });
    expect(((await provider().send(req("claude-sonnet-4-5@20250929")).catch((e) => e)) as LlmError).overloaded).toBe(true);
    reply = () => json(400, { error: { message: "prompt is too long: 300000 tokens > 200000 maximum" } });
    expect(((await provider().send(req("claude-sonnet-4-5@20250929")).catch((e) => e)) as LlmError).promptTooLong).toBe(true);
  });

  it("explains permission errors", async () => {
    reply = () => json(403, { error: { message: "Permission denied" } });
    const err = (await provider().send(req("claude-sonnet-4-5@20250929")).catch((e) => e)) as LlmError;
    expect(err.message).toMatch(/aiplatform\.user/);
  });
});

describe("Gemini on Vertex (OpenAI-compatible endpoint)", () => {
  beforeEach(() => {
    reply = () =>
      json(200, {
        model: "google/gemini-2.5-flash",
        choices: [{ message: { tool_calls: [{ function: { name: "emit_plan", arguments: '{"x":"gem"}' } }] } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      });
  });

  it("posts chat/completions to the project's openapi endpoint with a google/ model id and bearer token", async () => {
    const res = await provider().send(req("gemini-2.5-flash"));
    expect(calls[0].url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions",
    );
    expect(body(calls[0]).model).toBe("google/gemini-2.5-flash");
    expect(authOf(calls[0])).toBe("Bearer ya29.test-token");
    expect(res.toolInput).toEqual({ x: "gem" });
    expect(res.model).toBe("gemini-2.5-flash");
  });

  it("fetches the token per request, so hourly refresh is the token source's job", async () => {
    const p = provider();
    await p.send(req("gemini-2.5-flash"));
    await p.send(req("gemini-2.5-flash"));
    expect(tokenSource).toHaveBeenCalledTimes(2);
  });
});

describe("routing helpers", () => {
  it("routes by model id", () => {
    expect(isClaudeModel("claude-sonnet-4-5@20250929")).toBe(true);
    expect(isClaudeModel("gemini-2.5-pro")).toBe(false);
    expect(openAiModelId("gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
    expect(openAiModelId("meta/llama-3.3-70b-instruct-maas")).toBe("meta/llama-3.3-70b-instruct-maas");
    expect(vertexOpenAiBaseUrl("p", "europe-west1")).toBe(
      "https://europe-west1-aiplatform.googleapis.com/v1/projects/p/locations/europe-west1/endpoints/openapi",
    );
    expect(vertexClaudeUrl("p", "global", "m")).toContain("aiplatform.googleapis.com/v1/projects/p/locations/global/");
  });

  it("a stage mix routes each stage to the right API", async () => {
    reply = () =>
      json(200, {
        content: [{ type: "tool_use", name: "emit_plan", input: { x: 1 } }],
        choices: [{ message: { tool_calls: [{ function: { name: "emit_plan", arguments: "{}" } }] } }],
      });
    const p = provider();
    await p.send(req(p.modelFor("triage")));
    await p.send(req(p.modelFor("generate")));
    expect(calls[0].url).toContain("/endpoints/openapi/");
    expect(calls[1].url).toContain(":rawPredict");
  });
});
