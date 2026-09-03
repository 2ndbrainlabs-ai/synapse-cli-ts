// Exercises the real fetch path against a throwaway HTTP server, so the
// request body and response parsing are verified as wire behaviour rather than
// against a mocked client.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { OpenAICompatProvider } from "../../../src/providers/openai-compat.js";
import { LlmError } from "../../../src/providers/types.js";
import type { LlmTool } from "../../../src/providers/types.js";

const TOOL: LlmTool = {
  name: "emit_plan",
  description: "Emit the plan",
  parameters: {
    type: "object",
    required: ["body_source"],
    properties: { body_source: { type: "string" } },
  },
};

interface Captured {
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  path: string;
}

let server: http.Server;
let baseUrl: string;
let captured: Captured | null = null;
/** Next response: [status, body]. */
let next: [number, string] = [200, "{}"];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured = {
        body: raw ? JSON.parse(raw) : {},
        headers: req.headers,
        path: req.url ?? "",
      };
      const [status, body] = next;
      if (status === 429) res.setHeader("retry-after", "7");
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function makeProvider(overrides: Partial<{
  toolChoice: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  temperature: boolean;
  headers: Record<string, string>;
  apiKey: string | null;
}> = {}) {
  return new OpenAICompatProvider({
    id: "custom",
    label: "Test",
    baseUrl,
    apiKey: overrides.apiKey === undefined ? "k-123" : overrides.apiKey,
    caps: {
      toolChoice: overrides.toolChoice ?? true,
      maxTokensField: overrides.maxTokensField ?? "max_tokens",
      temperature: overrides.temperature ?? true,
      promptCache: false,
    },
    models: {
      triage: "m-triage",
      generate: "m-generate",
      verify: "m-verify",
      fallback_generate: "m-fallback",
    },
    headers: overrides.headers,
  });
}

function req(model = "m-generate") {
  return {
    model,
    maxTokens: 4096,
    temperature: 0,
    system: [{ text: "SYSTEM PROMPT", cache: true }],
    messages: [{ role: "user" as const, content: "hello" }],
    tool: TOOL,
  };
}

function toolCallResponse(args: unknown, name = "emit_plan") {
  return JSON.stringify({
    model: "server-model",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ function: { name, arguments: args } }],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
  });
}

function contentResponse(content: string) {
  return JSON.stringify({
    model: "server-model",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

describe("OpenAICompatProvider — request shape", () => {
  it("posts to /chat/completions with a forced tool_choice and bearer auth", async () => {
    next = [200, toolCallResponse('{"body_source":"return 1"}')];
    const res = await makeProvider().send(req());

    expect(captured!.path).toBe("/v1/chat/completions");
    expect(captured!.headers.authorization).toBe("Bearer k-123");
    expect(captured!.body.model).toBe("m-generate");
    expect(captured!.body.tool_choice).toEqual({
      type: "function",
      function: { name: "emit_plan" },
    });
    expect(captured!.body.tools).toEqual([
      { type: "function", function: { name: "emit_plan", description: "Emit the plan", parameters: TOOL.parameters } },
    ]);
    // System blocks collapse into a single leading system message.
    expect(captured!.body.messages).toEqual([
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "hello" },
    ]);
    expect(captured!.body.max_tokens).toBe(4096);
    expect(captured!.body.temperature).toBe(0);
    expect(captured!.body.response_format).toBeUndefined();

    expect(res.toolInput).toEqual({ body_source: "return 1" });
    expect(res.model).toBe("server-model");
    // Cached prompt tokens are reported separately, not double-counted.
    expect(res.usage.input_tokens).toBe(70);
    expect(res.usage.cache_read_input_tokens).toBe(30);
    expect(res.usage.output_tokens).toBe(20);
  });

  it("honours capability flags: max_completion_tokens and no temperature", async () => {
    next = [200, toolCallResponse('{"body_source":"x"}')];
    await makeProvider({ maxTokensField: "max_completion_tokens", temperature: false }).send(req());

    expect(captured!.body.max_completion_tokens).toBe(4096);
    expect(captured!.body.max_tokens).toBeUndefined();
    expect(captured!.body).not.toHaveProperty("temperature");
  });

  it("sends static extra headers and omits auth when there is no key (Ollama)", async () => {
    next = [200, toolCallResponse('{"body_source":"x"}')];
    await makeProvider({ apiKey: null, headers: { "X-Title": "Synapse CLI" } }).send(req());

    expect(captured!.headers["x-title"]).toBe("Synapse CLI");
    expect(captured!.headers.authorization).toBeUndefined();
  });

  it("falls back to JSON mode with an inlined schema when tool_choice is unsupported", async () => {
    next = [200, contentResponse('{"body_source":"return 2"}')];
    const res = await makeProvider({ toolChoice: false }).send(req());

    expect(captured!.body.tool_choice).toBeUndefined();
    expect(captured!.body.response_format).toEqual({ type: "json_object" });
    // Tools are still advertised, so a model that CAN call them still does.
    expect(captured!.body.tools).toBeDefined();
    const system = (captured!.body.messages as Array<{ role: string; content: string }>)[0];
    expect(system.content).toContain("SYSTEM PROMPT");
    expect(system.content).toContain("emit_plan");
    expect(system.content).toContain("body_source");

    expect(res.toolInput).toEqual({ body_source: "return 2" });
  });
});

describe("OpenAICompatProvider — structured-output extraction", () => {
  it("parses tool arguments given as an object, not a JSON string", async () => {
    next = [200, toolCallResponse({ body_source: "return 3" })];
    const res = await makeProvider().send(req());
    expect(res.toolInput).toEqual({ body_source: "return 3" });
  });

  it("accepts a lone tool call whose name the model changed", async () => {
    next = [200, toolCallResponse('{"body_source":"y"}', "emit_plan_v2")];
    const res = await makeProvider().send(req());
    expect(res.toolInput).toEqual({ body_source: "y" });
  });

  it("recovers JSON from prose and markdown fences", async () => {
    next = [
      200,
      contentResponse(
        'Sure! Here is the plan:\n```json\n{"body_source":"return 4"}\n```\nHope that helps.',
      ),
    ];
    const res = await makeProvider().send(req());
    expect(res.toolInput).toEqual({ body_source: "return 4" });
  });

  it("does not truncate on braces or escaped quotes inside a generated body", async () => {
    // The single largest field the backend asks for is Python source, which is
    // full of braces and quotes; naive brace matching corrupts it.
    const body = 'data = {"k": [1, 2]}\nif x:\n    return f"{data} \\" done"\n';
    next = [200, toolCallResponse(JSON.stringify({ body_source: body }))];
    const viaTool = await makeProvider().send(req());
    expect(viaTool.toolInput).toEqual({ body_source: body });

    next = [200, contentResponse("prose\n" + JSON.stringify({ body_source: body }) + "\ntrailing }")];
    const viaContent = await makeProvider({ toolChoice: false }).send(req());
    expect(viaContent.toolInput).toEqual({ body_source: body });
  });

  it("returns null — never throws — when the model produced nothing usable", async () => {
    next = [200, contentResponse("I cannot help with that.")];
    const res = await makeProvider().send(req());
    expect(res.toolInput).toBeNull();
  });
});

describe("OpenAICompatProvider — error normalisation", () => {
  it("maps 429 with retry-after", async () => {
    next = [429, JSON.stringify({ error: { message: "rate limited" } })];
    const err = await makeProvider().send(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(7);
    expect(err.promptTooLong).toBe(false);
  });

  it("flags 503 as overloaded so backoff widens its jitter", async () => {
    next = [503, JSON.stringify({ error: { message: "overloaded" } })];
    const err = await makeProvider().send(req()).catch((e) => e);
    expect(err.overloaded).toBe(true);
  });

  it("classifies a context-window 400 as promptTooLong, not retryable", async () => {
    next = [
      400,
      JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }),
    ];
    const err = await makeProvider().send(req()).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.promptTooLong).toBe(true);
  });

  it("surfaces an error body returned with HTTP 200", async () => {
    next = [200, JSON.stringify({ error: { message: "bad model" } })];
    const err = await makeProvider().send(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain("bad model");
  });

  it("explains a non-JSON body instead of throwing a parse error", async () => {
    next = [200, "<html>not an API</html>"];
    const err = await makeProvider().send(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain("OpenAI-compatible");
  });

  it("marks an unreachable endpoint as a connection error", async () => {
    const dead = new OpenAICompatProvider({
      id: "custom",
      label: "Dead",
      // Port 1 is reserved and refuses connections.
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: null,
      caps: { toolChoice: true, maxTokensField: "max_tokens", temperature: true, promptCache: false },
      models: { triage: "m", generate: "m", verify: "m", fallback_generate: "m" },
    });
    const err = await dead.send(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.connection).toBe(true);
  });
});

describe("OpenAICompatProvider — model mapping", () => {
  it("resolves a model per pipeline stage", () => {
    const p = makeProvider();
    expect(p.modelFor("triage")).toBe("m-triage");
    expect(p.modelFor("generate")).toBe("m-generate");
    expect(p.modelFor("fallback_generate")).toBe("m-fallback");
  });
});
