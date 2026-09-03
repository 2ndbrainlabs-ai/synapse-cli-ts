// Provider divergence, asserted against the REAL catalog.
//
// tests/unit/providers/openai-compat.test.ts covers the adapter's behaviour for
// hand-built capability flags. This file closes the other half: that each
// shipped provider's catalog entry actually produces the request shape its
// provider requires. Without it, a wrong flag in catalog.ts — the kind of edit
// that looks harmless — would pass every other test and fail only against a
// live API.
//
// Each expectation below maps to a documented provider constraint:
//   OpenAI  — max_tokens is rejected by reasoning models; temperature too.
//   Ollama  — tool_choice is documented as unsupported.
//   OpenRouter — wants HTTP-Referer / X-Title attribution headers.
//   Groq / xAI — standard on all four fields.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { OpenAICompatProvider } from "../../../src/providers/openai-compat.js";
import { createProvider } from "../../../src/providers/index.js";
import {
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  keyFromEnv,
} from "../../../src/providers/catalog.js";
import type { ProviderId, LlmTool, Task } from "../../../src/providers/types.js";

const TASKS: Task[] = ["triage", "generate", "verify", "fallback_generate"];

const TOOL: LlmTool = {
  name: "emit_plan",
  description: "d",
  parameters: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
};

let server: http.Server;
let origin: string;
let body: Record<string, unknown> = {};
let headers: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = raw ? JSON.parse(raw) : {};
      headers = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "srv",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ function: { name: "emit_plan", arguments: '{"x":"1"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * Build a provider from the real catalog entry, but point it at the local
 * server. Everything except baseUrl comes from catalog.ts.
 */
function fromCatalog(id: ProviderId) {
  const spec = PROVIDERS[id];
  return new OpenAICompatProvider({
    id: spec.id,
    label: spec.label,
    baseUrl: origin,
    apiKey: "k",
    caps: spec.caps,
    models: spec.defaults.generate
      ? (spec.defaults as Record<Task, string>)
      : { triage: "m", generate: "m", verify: "m", fallback_generate: "m" },
    headers: spec.headers,
  });
}

async function send(id: ProviderId) {
  const p = fromCatalog(id);
  await p.send({
    model: p.modelFor("generate"),
    maxTokens: 4096,
    temperature: 0,
    system: [{ text: "SYS", cache: true }],
    messages: [{ role: "user", content: "hi" }],
    tool: TOOL,
  });
  return { body, headers };
}

// -----------------------------------------------------------------------------
// Output-cap field name
// -----------------------------------------------------------------------------

describe("divergence: output-token field name", () => {
  it("OpenAI gets max_completion_tokens and never max_tokens", async () => {
    // Reasoning models (gpt-5, o-series) reject max_tokens outright.
    const { body } = await send("openai");
    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it.each(["groq", "grok", "openrouter", "ollama"] as ProviderId[])(
    "%s gets the classic max_tokens",
    async (id) => {
      const { body } = await send(id);
      expect(body.max_tokens).toBe(4096);
      expect(body).not.toHaveProperty("max_completion_tokens");
    },
  );
});

// -----------------------------------------------------------------------------
// temperature
// -----------------------------------------------------------------------------

describe("divergence: temperature", () => {
  it("OpenAI omits temperature entirely", async () => {
    // Reasoning models 400 on temperature; omitting is safe for both families.
    const { body } = await send("openai");
    expect(body).not.toHaveProperty("temperature");
  });

  it.each(["groq", "grok", "openrouter", "ollama"] as ProviderId[])(
    "%s receives temperature",
    async (id) => {
      const { body } = await send(id);
      expect(body.temperature).toBe(0);
    },
  );
});

// -----------------------------------------------------------------------------
// Structured output: tool_choice vs JSON mode
// -----------------------------------------------------------------------------

describe("divergence: structured-output strategy", () => {
  it("Ollama omits tool_choice and switches to JSON mode", async () => {
    const { body } = await send("ollama");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.response_format).toEqual({ type: "json_object" });

    // Tools are still offered, so a tool-capable model still calls them.
    expect(body.tools).toBeDefined();

    // The schema has to reach the model somehow; on this path it rides the
    // system prompt, otherwise the model has no idea what shape to emit.
    const sys = (body.messages as Array<{ role: string; content: string }>)[0];
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("emit_plan");
    expect(sys.content).toContain('"required":["x"]');
  });

  it.each(["openai", "groq", "grok", "openrouter"] as ProviderId[])(
    "%s forces the tool call and does not set response_format",
    async (id) => {
      const { body } = await send(id);
      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "emit_plan" },
      });
      expect(body).not.toHaveProperty("response_format");
    },
  );

  it("keeps the system prompt clean when tool_choice is available", async () => {
    // No schema dump in the prompt — it would waste tokens on every call.
    const { body } = await send("groq");
    const sys = (body.messages as Array<{ content: string }>)[0];
    expect(sys.content).toBe("SYS");
  });
});

// -----------------------------------------------------------------------------
// Headers
// -----------------------------------------------------------------------------

describe("divergence: headers", () => {
  it("OpenRouter sends its attribution headers", async () => {
    const { headers } = await send("openrouter");
    expect(headers["http-referer"]).toBeDefined();
    expect(headers["x-title"]).toBe("Synapse CLI");
  });

  it.each(["openai", "groq", "grok", "ollama"] as ProviderId[])(
    "%s sends no attribution headers",
    async (id) => {
      const { headers } = await send(id);
      expect(headers["x-title"]).toBeUndefined();
      expect(headers["http-referer"]).toBeUndefined();
    },
  );

  it("every OpenAI-shaped provider authenticates with a bearer token", async () => {
    for (const id of ["openai", "groq", "grok", "openrouter", "ollama"] as ProviderId[]) {
      const { headers } = await send(id);
      expect(headers.authorization).toBe("Bearer k");
    }
  });
});

// -----------------------------------------------------------------------------
// Endpoint construction
// -----------------------------------------------------------------------------

describe("endpoint construction", () => {
  it("appends /chat/completions to the configured root", () => {
    const p = new OpenAICompatProvider({
      id: "custom",
      label: "C",
      baseUrl: "https://x.test/v1",
      apiKey: null,
      caps: PROVIDERS.groq.caps,
      models: { triage: "m", generate: "m", verify: "m", fallback_generate: "m" },
    });
    expect((p as unknown as { endpoint: string }).endpoint).toBe(
      "https://x.test/v1/chat/completions",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    const p = new OpenAICompatProvider({
      id: "custom",
      label: "C",
      baseUrl: "https://x.test/v1///",
      apiKey: null,
      caps: PROVIDERS.groq.caps,
      models: { triage: "m", generate: "m", verify: "m", fallback_generate: "m" },
    });
    expect((p as unknown as { endpoint: string }).endpoint).toBe(
      "https://x.test/v1/chat/completions",
    );
  });
});

// -----------------------------------------------------------------------------
// Catalog invariants — cheap guards against a malformed entry shipping
// -----------------------------------------------------------------------------

describe("catalog invariants", () => {
  it("declares every provider the type union allows", () => {
    expect(PROVIDER_IDS.sort()).toEqual(
      ["anthropic", "custom", "groq", "grok", "ollama", "openai", "openrouter"].sort(),
    );
    for (const id of PROVIDER_IDS) expect(isProviderId(id)).toBe(true);
    expect(isProviderId("gpt6")).toBe(false);
  });

  it("gives each entry a self-consistent identity", () => {
    for (const id of PROVIDER_IDS) {
      const spec = PROVIDERS[id];
      expect(spec.id).toBe(id);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.docsUrl).toMatch(/^https:\/\//);
      expect(spec.apiKeyEnv.length).toBeGreaterThan(0);
    }
  });

  it("supplies a model for every pipeline stage, or none at all", () => {
    for (const id of PROVIDER_IDS) {
      const defaults = PROVIDERS[id].defaults;
      const filled = TASKS.filter((t) => defaults[t]).length;
      // `custom` intentionally ships no defaults — the user supplies the model.
      expect(filled === 0 || filled === TASKS.length).toBe(true);
      if (id === "custom") expect(filled).toBe(0);
      else expect(filled).toBe(TASKS.length);
    }
  });

  it("uses a cheaper model for triage than for generation where it matters", () => {
    // Triage is a high-volume fan-out; running the strong model there is the
    // single easiest way to make local builds expensive.
    for (const id of ["anthropic", "openai", "groq", "openrouter"] as ProviderId[]) {
      const d = PROVIDERS[id].defaults;
      expect(d.triage).not.toBe(d.generate);
      expect(d.fallback_generate).toBe(d.triage);
    }
  });

  it("has an endpoint for every OpenAI-shaped provider except custom", () => {
    for (const id of PROVIDER_IDS) {
      const spec = PROVIDERS[id];
      if (spec.kind !== "openai-compat") continue;
      if (id === "custom") expect(spec.baseUrl).toBeNull();
      else expect(spec.baseUrl).toMatch(/^https?:\/\//);
    }
  });

  it("only waives the key requirement where a key is genuinely optional", () => {
    // Ollama ignores the key; a custom endpoint may be unauthenticated.
    const optional = PROVIDER_IDS.filter((id) => !PROVIDERS[id].keyRequired).sort();
    expect(optional).toEqual(["custom", "ollama"]);
  });

  it("routes Anthropic through its own adapter and everything else through one", () => {
    expect(PROVIDERS.anthropic.kind).toBe("anthropic");
    for (const id of PROVIDER_IDS.filter((i) => i !== "anthropic")) {
      expect(PROVIDERS[id].kind).toBe("openai-compat");
    }
  });

  it("claims prompt caching only for Anthropic", () => {
    // The neutral `cache` hint is only honoured natively there; asserting this
    // stops a copy-paste from silently implying caching elsewhere.
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id].caps.promptCache).toBe(id === "anthropic");
    }
  });
});

// -----------------------------------------------------------------------------
// Key discovery
// -----------------------------------------------------------------------------

describe("keyFromEnv", () => {
  const saved: Record<string, string | undefined> = {};
  const vars = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "GROK_API_KEY",
    "OPENROUTER_API_KEY",
    "SYNAPSE_LLM_API_KEY",
  ];

  beforeAll(() => {
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterAll(() => {
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v]!;
    }
  });

  it("prefers the provider's own variable over the generic fallback", () => {
    process.env.GROQ_API_KEY = "gsk-specific";
    process.env.SYNAPSE_LLM_API_KEY = "generic";
    expect(keyFromEnv("groq")).toBe("gsk-specific");
    delete process.env.GROQ_API_KEY;
    expect(keyFromEnv("groq")).toBe("generic");
    delete process.env.SYNAPSE_LLM_API_KEY;
  });

  it("prefers XAI_API_KEY over GROK_API_KEY but accepts either", () => {
    process.env.GROK_API_KEY = "from-grok-var";
    expect(keyFromEnv("grok")).toBe("from-grok-var");
    process.env.XAI_API_KEY = "from-xai-var";
    expect(keyFromEnv("grok")).toBe("from-xai-var");
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
  });

  it("ignores a variable that is set but blank", () => {
    process.env.OPENAI_API_KEY = "   ";
    expect(keyFromEnv("openai")).toBeNull();
    delete process.env.OPENAI_API_KEY;
  });

  it("trims surrounding whitespace off a key", () => {
    process.env.OPENAI_API_KEY = "  sk-padded  ";
    expect(keyFromEnv("openai")).toBe("sk-padded");
    delete process.env.OPENAI_API_KEY;
  });

  it("returns null when nothing is set", () => {
    expect(keyFromEnv("openai")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// createProvider guards
// -----------------------------------------------------------------------------

describe("createProvider", () => {
  const base = {
    models: { triage: "m", generate: "m", verify: "m", fallback_generate: "m" },
    caps: PROVIDERS.groq.caps,
    headers: {},
  };

  it("refuses an OpenAI-shaped provider with no endpoint", () => {
    expect(() =>
      createProvider({
        ...base,
        providerId: "custom",
        label: "C",
        kind: "openai-compat",
        baseUrl: null,
        apiKey: "k",
      }),
    ).toThrow(/requires a base URL/);
  });

  it("refuses Anthropic with no key", () => {
    expect(() =>
      createProvider({
        ...base,
        providerId: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        baseUrl: null,
        apiKey: null,
      }),
    ).toThrow(/requires an API key/);
  });

  it("allows a keyless OpenAI-shaped endpoint (local Ollama)", () => {
    const p = createProvider({
      ...base,
      providerId: "ollama",
      label: "Ollama",
      kind: "openai-compat",
      baseUrl: "http://localhost:11434/v1",
      apiKey: null,
    });
    expect(p.id).toBe("ollama");
    expect(p.modelFor("generate")).toBe("m");
  });
});
