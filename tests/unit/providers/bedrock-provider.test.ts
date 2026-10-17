// The Bedrock adapter speaks the Converse API through the real AWS SDK, pointed
// at a local HTTP server via `endpoint`. Assertions are on the SDK's actual
// serialised requests and on how real AWS error responses deserialise — not on
// a stubbed client. The Bedrock runtime client speaks HTTP/2, so the test
// server is a cleartext HTTP/2 server.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

import {
  BedrockProvider,
  bedrockSupportsForcedTool,
  bedrockSupportsCache,
} from "../../../src/providers/bedrock.js";
import { LlmError } from "../../../src/providers/types.js";
import type { LlmRequest, LlmTool, Task } from "../../../src/providers/types.js";

const TOOL: LlmTool = {
  name: "emit_plan",
  description: "Emit the plan",
  parameters: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
};

const CLAUDE = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const LLAMA = "meta.llama3-1-70b-instruct-v1:0";

const MODELS: Record<Task, string> = {
  triage: CLAUDE,
  generate: CLAUDE,
  verify: CLAUDE,
  fallback_generate: CLAUDE,
};

let server: http2.Http2Server;
let endpoint: string;
let captured: { path: string; body: Record<string, unknown>; headers: http2.IncomingHttpHeaders };
let next: { status: number; body: string; headers?: Record<string, string> };

function converse(content: unknown[]) {
  return JSON.stringify({
    output: { message: { role: "assistant", content } },
    stopReason: "tool_use",
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadInputTokens: 800, cacheWriteInputTokens: 40 },
    metrics: { latencyMs: 10 },
  });
}

function req(model = CLAUDE, cache = true): LlmRequest {
  return {
    model,
    maxTokens: 512,
    temperature: 0,
    system: [{ text: "STABLE PREFIX", cache }, { text: "volatile" }],
    messages: [{ role: "user", content: "go" }],
    tool: TOOL,
  };
}

const savedEnv: Record<string, string | undefined> = {};
const ENV = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_BEARER_TOKEN_BEDROCK"];

beforeAll(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_ACCESS_KEY_ID = "AKIATESTTESTTEST";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";

  server = http2.createServer((r, res) => {
    let raw = "";
    r.on("data", (c) => (raw += c));
    r.on("end", () => {
      captured = { path: r.url ?? "", body: raw ? JSON.parse(raw) : {}, headers: r.headers };
      res.writeHead(next.status, { "content-type": "application/json", ...(next.headers ?? {}) });
      res.end(next.body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  next = { status: 200, body: converse([{ toolUse: { toolUseId: "t1", name: "emit_plan", input: { x: "ok" } } }]) };
});

const provider = () => new BedrockProvider({ region: "us-east-1", endpoint, models: MODELS });

describe("BedrockProvider request shape", () => {
  it("calls Converse for the model, SigV4-signed with the default credential chain", async () => {
    await provider().send(req());
    expect(captured.path).toBe(`/model/${encodeURIComponent(CLAUDE)}/converse`);
    expect(String(captured.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTEST\//);
  });

  it("forces the named tool for Claude and sends its schema as inputSchema.json", async () => {
    await provider().send(req());
    const toolConfig = captured.body.toolConfig as Record<string, unknown>;
    expect(toolConfig.toolChoice).toEqual({ tool: { name: "emit_plan" } });
    expect(toolConfig.tools).toEqual([
      { toolSpec: { name: "emit_plan", description: "Emit the plan", inputSchema: { json: TOOL.parameters } } },
    ]);
  });

  it("places a cachePoint after the cacheable prefix only", async () => {
    await provider().send(req());
    expect(captured.body.system).toEqual([
      { text: "STABLE PREFIX" },
      { cachePoint: { type: "default" } },
      { text: "volatile" },
    ]);
  });

  it("maps maxTokens / temperature into inferenceConfig and messages into content blocks", async () => {
    await provider().send(req());
    expect(captured.body.inferenceConfig).toEqual({ maxTokens: 512, temperature: 0 });
    expect(captured.body.messages).toEqual([{ role: "user", content: [{ text: "go" }] }]);
  });

  it("falls back to toolChoice auto + schema-in-prompt for families that can't force a tool", async () => {
    next = { status: 200, body: converse([{ text: 'Sure: {"x": "from-text"}' }]) };
    const res = await provider().send(req(LLAMA, true));
    const toolConfig = captured.body.toolConfig as Record<string, unknown>;
    expect(toolConfig.toolChoice).toEqual({ auto: {} });
    const system = captured.body.system as Array<Record<string, unknown>>;
    expect(system.some((b) => "cachePoint" in b)).toBe(false);
    expect(String(system[system.length - 1].text)).toContain("REQUIRED OUTPUT");
    expect(res.toolInput).toEqual({ x: "from-text" });
  });
});

describe("BedrockProvider response handling", () => {
  it("returns the tool input and normalised usage, including cache tokens", async () => {
    const res = await provider().send(req());
    expect(res.toolInput).toEqual({ x: "ok" });
    expect(res.usage).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40,
    });
  });

  it("returns null toolInput when the model produced neither a tool call nor JSON", async () => {
    next = { status: 200, body: converse([{ text: "no idea" }]) };
    expect((await provider().send(req())).toolInput).toBeNull();
  });
});

describe("BedrockProvider error mapping", () => {
  const awsError = (status: number, type: string, message: string) => ({
    status,
    body: JSON.stringify({ message }),
    headers: { "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/` },
  });

  it("throttling is a retryable 429", async () => {
    next = awsError(429, "ThrottlingException", "Too many requests");
    const err = (await provider().send(req()).catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(429);
  });

  it("service unavailable is flagged overloaded", async () => {
    next = awsError(503, "ServiceUnavailableException", "busy");
    const err = (await provider().send(req()).catch((e) => e)) as LlmError;
    expect(err.overloaded).toBe(true);
  });

  it("an over-long prompt is promptTooLong, never retried", async () => {
    next = awsError(400, "ValidationException", "Input is too long for requested model.");
    const err = (await provider().send(req()).catch((e) => e)) as LlmError;
    expect(err.promptTooLong).toBe(true);
  });

  it("access denied tells the user to enable model access", async () => {
    next = awsError(403, "AccessDeniedException", "You don't have access to the model");
    const err = (await provider().send(req()).catch((e) => e)) as LlmError;
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/Model access/);
  });
});

describe("model family detection", () => {
  it("forces tools only for families that support it", () => {
    expect(bedrockSupportsForcedTool(CLAUDE)).toBe(true);
    expect(bedrockSupportsForcedTool("anthropic.claude-3-haiku-20240307-v1:0")).toBe(true);
    expect(bedrockSupportsForcedTool("us.amazon.nova-pro-v1:0")).toBe(true);
    expect(bedrockSupportsForcedTool("mistral.mistral-large-2407-v1:0")).toBe(true);
    expect(bedrockSupportsForcedTool(LLAMA)).toBe(false);
  });

  it("caches only for Claude and Nova", () => {
    expect(bedrockSupportsCache(CLAUDE)).toBe(true);
    expect(bedrockSupportsCache("us.amazon.nova-pro-v1:0")).toBe(true);
    expect(bedrockSupportsCache("mistral.mistral-large-2407-v1:0")).toBe(false);
  });
});
