// End-to-end proof that the whole local codegen pipeline runs on a non-Anthropic
// provider: real HTTP, real OpenAI-shaped payloads, real classify → shape →
// render → smoke-verify, producing a real Python MCP server file.
//
// The mock endpoint stands in for OpenAI / Groq / xAI / OpenRouter / Ollama /
// self-hosted alike — they share one adapter, so covering the wire contract
// covers all of them. Both structured-output paths are exercised: forced
// tool_choice, and the JSON-mode fallback used when a provider ignores it.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { LocalSynapseClient } from "../../src/backend/index.js";
import { createProvider } from "../../src/providers/index.js";
import type { SurfaceManifest } from "../../src/extractors/core/surface-manifest.js";

function manifest(): SurfaceManifest {
  return {
    language: "python",
    framework: "fastapi",
    package_import_root: "app",
    endpoints: [],
    functions: [
      {
        module: "app.users",
        qualname: "get_user_by_id",
        signature: "def get_user_by_id(user_id: str) -> dict",
        docstring: "Fetch a user row by id.",
        is_async: false,
        is_public: true,
        file_path: "app/users.py",
        start_line: 10,
        end_line: 20,
      },
      {
        module: "app.users",
        qualname: "get_user_orders",
        signature: "def get_user_orders(user_id: str) -> list",
        docstring: "List orders for a user.",
        is_async: false,
        is_public: true,
        file_path: "app/users.py",
        start_line: 22,
        end_line: 30,
      },
    ],
  };
}

const TOOL_PLAN = {
  tool_name: "user_profile_with_orders",
  description: "Fetch a user and their orders in one call.",
  param_names: ["user_id"],
  param_types: ["str"],
  // Every call must resolve to a manifest function or a builtin, or auditBody
  // rejects the plan.
  body_source:
    'user = get_user_by_id(user_id=user_id)\n' +
    'orders = get_user_orders(user_id=user_id)\n' +
    'return {"user": user, "orders": orders}\n',
  imports: [],
  env_vars: ["DATABASE_URL"],
  is_async: false,
};

let server: http.Server;
let baseUrl: string;
/** Requests seen, for asserting the wire contract. */
let seen: Array<{ tool: string; model: string; hasToolChoice: boolean }> = [];
/** When true, respond via message.content instead of tool_calls. */
let jsonModeOnly = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        model: string;
        tool_choice?: unknown;
        tools: Array<{ function: { name: string } }>;
        messages: Array<{ role: string; content: string }>;
      };
      const toolName = body.tools[0].function.name;
      seen.push({
        tool: toolName,
        model: body.model,
        hasToolChoice: body.tool_choice !== undefined,
      });

      let payload: unknown;
      if (toolName === "emit_shard_verdicts") {
        const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
        const quals = ["get_user_by_id", "get_user_orders"].filter((q) =>
          userMsg.includes(q),
        );
        payload = {
          verdicts: quals.map((qualname) => ({
            qualname,
            band: "HIGH",
            tool_shape: "single",
            workflow_hints: [],
            one_line_purpose: "does a thing",
          })),
        };
      } else if (toolName === "emit_tool_plan") {
        payload = TOOL_PLAN;
      } else {
        payload = {};
      }

      const message = jsonModeOnly
        ? // Wrapped in prose + fences, the way a weaker model answers.
          { content: "Here you go:\n```json\n" + JSON.stringify(payload) + "\n```" }
        : {
            content: null,
            tool_calls: [
              { function: { name: toolName, arguments: JSON.stringify(payload) } },
            ],
          };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message }],
          usage: { prompt_tokens: 1200, completion_tokens: 340 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function client(opts: { toolChoice: boolean }) {
  return new LocalSynapseClient({
    provider: createProvider({
      providerId: "custom",
      label: "Mock GPU cluster",
      kind: "openai-compat",
      baseUrl,
      apiKey: "test-key",
      models: {
        triage: "mock-small",
        generate: "mock-large",
        verify: "mock-large",
        fallback_generate: "mock-small",
      },
      caps: {
        toolChoice: opts.toolChoice,
        maxTokensField: "max_tokens",
        temperature: true,
        promptCache: false,
      },
      headers: {},
    }),
    workingDir: process.cwd(),
  });
}

describe("local pipeline on an OpenAI-compatible provider", () => {
  it("generates a verified Python MCP server via forced tool calls", async () => {
    seen = [];
    jsonModeOnly = false;

    const result = await client({ toolChoice: true }).buildCustom({
      language: "python",
      manifestJson: JSON.stringify(manifest()),
      intent: "Give me a user profile with their orders",
      selectedQualnames: ["get_user_by_id", "get_user_orders"],
      suggestedToolName: "user_profile_with_orders",
      sessionId: "test-forced",
    });

    expect(result.error).toBe("");
    expect(result.success).toBe(true);
    expect(result.tool_name).toBe("user_profile_with_orders");
    expect(result.file_extension).toBe("py");
    expect(result.env_vars).toEqual(["DATABASE_URL"]);

    // Real generated source, wired to the real manifest imports.
    expect(result.file_source).toContain("from mcp.server.fastmcp import FastMCP");
    expect(result.file_source).toContain("from app.users import");
    expect(result.file_source).toContain("get_user_by_id(user_id=user_id)");
    expect(result.file_source).toContain("get_user_orders(user_id=user_id)");

    // Smoke-verify passed, so no repair round was needed.
    expect(JSON.parse(result.report_json).verify_ok).toBe(true);

    // The shaping stage ran on the generate model with tool_choice pinned.
    const shape = seen.find((s) => s.tool === "emit_tool_plan");
    expect(shape).toBeDefined();
    expect(shape!.model).toBe("mock-large");
    expect(shape!.hasToolChoice).toBe(true);
  });

  it("produces the same server when the provider ignores tool_choice", async () => {
    seen = [];
    jsonModeOnly = true;

    const result = await client({ toolChoice: false }).buildCustom({
      language: "python",
      manifestJson: JSON.stringify(manifest()),
      intent: "Give me a user profile with their orders",
      selectedQualnames: ["get_user_by_id", "get_user_orders"],
      suggestedToolName: "user_profile_with_orders",
      sessionId: "test-jsonmode",
    });

    expect(result.error).toBe("");
    expect(result.success).toBe(true);
    expect(result.file_source).toContain("get_user_orders(user_id=user_id)");
    expect(seen.every((s) => s.hasToolChoice === false)).toBe(true);
  });

  it("classifies candidates on the cheap triage model", async () => {
    seen = [];
    jsonModeOnly = false;

    const result = await client({ toolChoice: true }).classifyCandidates({
      manifestJson: JSON.stringify(manifest()),
      sessionId: "test-classify",
    });

    expect(result.success).toBe(true);
    expect(result.error).toBe("");
    expect(result.verdicts.map((v) => v.qualname).sort()).toEqual([
      "get_user_by_id",
      "get_user_orders",
    ]);
    expect(seen.every((s) => s.model === "mock-small")).toBe(true);
  });

  it("names endpoints through the same provider", async () => {
    seen = [];
    jsonModeOnly = false;

    // The namer's tool is emit_endpoint_names; serve it from the mock.
    const named = await client({ toolChoice: true }).nameEndpoints({
      endpoints: [
        {
          method: "GET",
          path: "/users/{id}",
          handler_qualname: "get_user",
          handler_source: "def get_user(id): ...",
          existing_description: "",
        },
      ] as never,
      workingDir: process.cwd(),
      sessionId: "test-names",
    });

    // The mock returns {} for emit_endpoint_names, so no names come back — the
    // point is that the call reached the provider and failed soft, not hard.
    expect(named.success).toBe(true);
    expect(seen.some((s) => s.tool === "emit_endpoint_names")).toBe(true);
  });
});

describe("provider errors surface as build failures, not crashes", () => {
  it("reports an unreachable endpoint as a build error", async () => {
    const dead = new LocalSynapseClient({
      provider: createProvider({
        providerId: "custom",
        label: "Dead cluster",
        kind: "openai-compat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: null,
        models: {
          triage: "m",
          generate: "m",
          verify: "m",
          fallback_generate: "m",
        },
        caps: {
          toolChoice: true,
          maxTokensField: "max_tokens",
          temperature: true,
          promptCache: false,
        },
        headers: {},
      }),
    });

    const result = await dead.buildCustom({
      language: "python",
      manifestJson: JSON.stringify(manifest()),
      intent: "anything",
      selectedQualnames: ["get_user_by_id"],
      sessionId: "test-dead",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("could not reach");
  }, 30_000);
});
