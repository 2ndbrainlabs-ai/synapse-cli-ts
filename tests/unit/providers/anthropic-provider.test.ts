// The Anthropic adapter keeps the native Messages API rather than going through
// the OpenAI-compatible path, so its request shape is a separate contract:
// `input_schema` (not `parameters`), `tool_choice: {type:"tool"}` (not
// `{type:"function"}`), system as an array of blocks, and ephemeral
// cache_control on the cacheable prefix.
//
// Driven against a local HTTP server via the SDK's baseURL, so the assertions
// are on real serialised requests rather than a stubbed client.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { AnthropicProvider } from "../../../src/providers/anthropic.js";
import { LlmError } from "../../../src/providers/types.js";
import { PROVIDERS } from "../../../src/providers/catalog.js";
import type { LlmTool, Task } from "../../../src/providers/types.js";

const TOOL: LlmTool = {
  name: "emit_plan",
  description: "Emit the plan",
  parameters: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
};

const MODELS: Record<Task, string> = {
  triage: "claude-haiku-test",
  generate: "claude-sonnet-test",
  verify: "claude-sonnet-test",
  fallback_generate: "claude-haiku-test",
};

let server: http.Server;
let baseUrl: string;
let captured: { body: Record<string, unknown>; path: string; headers: http.IncomingHttpHeaders };
let next: [number, string] = [200, ""];
let requestCount = 0;

function messageResponse(input: unknown, name = "emit_plan") {
  return JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-test",
    content: [{ type: "tool_use", id: "tu_1", name, input }],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 120,
      output_tokens: 34,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requestCount += 1;
      captured = { body: raw ? JSON.parse(raw) : {}, path: req.url ?? "", headers: req.headers };
      const [status, payload] = next;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload || messageResponse({ x: "1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function provider() {
  return new AnthropicProvider({ apiKey: "sk-ant-test", baseUrl, models: MODELS });
}

function req() {
  return {
    model: "claude-sonnet-test",
    maxTokens: 8192,
    temperature: 0,
    system: [
      { text: "STABLE PREFIX", cache: true },
      { text: "VOLATILE SUFFIX" },
    ],
    messages: [{ role: "user" as const, content: "hi" }],
    tool: TOOL,
  };
}

describe("AnthropicProvider — native request shape", () => {
  it("uses input_schema and the tool-typed tool_choice", async () => {
    next = [200, ""];
    const res = await provider().send(req());

    expect(captured.path).toContain("/v1/messages");
    expect(captured.body.tools).toEqual([
      { name: "emit_plan", description: "Emit the plan", input_schema: TOOL.parameters },
    ]);
    // Anthropic's discriminator is "tool"; OpenAI's is "function".
    expect(captured.body.tool_choice).toEqual({ type: "tool", name: "emit_plan" });
    expect(captured.body.max_tokens).toBe(8192);
    expect(captured.body.temperature).toBe(0);
    expect(res.toolInput).toEqual({ x: "1" });
  });

  it("marks only the cacheable system block with ephemeral cache_control", async () => {
    next = [200, ""];
    await provider().send(req());

    expect(captured.body.system).toEqual([
      { type: "text", text: "STABLE PREFIX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "VOLATILE SUFFIX" },
    ]);
  });

  it("reports cache usage separately from fresh input tokens", async () => {
    next = [200, ""];
    const res = await provider().send(req());

    expect(res.usage.input_tokens).toBe(120);
    expect(res.usage.cache_read_input_tokens).toBe(900);
    expect(res.usage.cache_creation_input_tokens).toBe(50);
    expect(res.usage.output_tokens).toBe(34);
    expect(res.model).toBe("claude-sonnet-test");
  });

  it("resolves a model per pipeline stage", () => {
    const p = provider();
    expect(p.id).toBe("anthropic");
    expect(p.modelFor("triage")).toBe("claude-haiku-test");
    expect(p.modelFor("generate")).toBe("claude-sonnet-test");
  });

  it("leaves retries to llm-call rather than retrying inside the SDK", async () => {
    // The SDK defaults to 2 internal retries. Left on, a single logical call
    // would fan out to 3 HTTP requests, multiplying backoff and corrupting the
    // `attempt` number in trace records.
    next = [500, JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } })];
    requestCount = 0;
    await provider().send(req()).catch(() => undefined);
    expect(requestCount).toBe(1);
  });
});

describe("AnthropicProvider — output extraction", () => {
  it("returns null when the response carries no matching tool_use block", async () => {
    next = [
      200,
      JSON.stringify({
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-test",
        content: [{ type: "text", text: "I would rather not." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    ];
    const res = await provider().send(req());
    expect(res.toolInput).toBeNull();
  });

  it("ignores a tool_use block for a different tool", async () => {
    next = [200, messageResponse({ x: "1" }, "some_other_tool")];
    const res = await provider().send(req());
    expect(res.toolInput).toBeNull();
  });

  it("treats an empty tool input as an empty object, not a failure", async () => {
    next = [200, messageResponse({})];
    const res = await provider().send(req());
    expect(res.toolInput).toEqual({});
  });
});

describe("AnthropicProvider — error normalisation", () => {
  it("wraps API errors as LlmError carrying the status", async () => {
    next = [
      429,
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
    ];
    const err = await provider().send(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(429);
  });

  it("flags 529 as overloaded so the backup-model ladder can engage", async () => {
    next = [
      529,
      JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }),
    ];
    const err = await provider().send(req()).catch((e) => e);
    expect(err.overloaded).toBe(true);
  });

  it("flags a long-prompt 400 as promptTooLong so callers shrink instead of retry", async () => {
    next = [
      400,
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens" },
      }),
    ];
    const err = await provider().send(req()).catch((e) => e);
    expect(err.promptTooLong).toBe(true);
  });

  it("does not mistake an ordinary 400 for a context overflow", async () => {
    next = [
      400,
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "model: unknown model" },
      }),
    ];
    const err = await provider().send(req()).catch((e) => e);
    expect(err.promptTooLong).toBe(false);
    expect(err.status).toBe(400);
  });
});

describe("catalog wiring for Anthropic", () => {
  it("keeps the native adapter and prompt caching", () => {
    const spec = PROVIDERS.anthropic;
    expect(spec.kind).toBe("anthropic");
    expect(spec.caps.promptCache).toBe(true);
    expect(spec.caps.toolChoice).toBe(true);
    // Native API, so the OpenAI field-name divergences don't apply.
    expect(spec.caps.maxTokensField).toBe("max_tokens");
    expect(spec.caps.temperature).toBe(true);
    // No default base URL — the SDK's own default is used.
    expect(spec.baseUrl).toBeNull();
  });
});
