// Precedence and validation for the `llm` config block.
//
// The global config path is redirected into a temp dir so these tests never
// read or write the developer's real ~/.synapse.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-llm-home-"));
const TMP_GLOBAL_DIR = path.join(TMP_HOME, ".synapse");
const TMP_GLOBAL_CONFIG = path.join(TMP_GLOBAL_DIR, "config.json");

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  return {
    ...actual,
    GLOBAL_SYNAPSE_DIR: TMP_GLOBAL_DIR,
    GLOBAL_CONFIG_PATH: TMP_GLOBAL_CONFIG,
  };
});

const { resolveLlm, LlmSettingsSchema, writeLlmSettings, readGlobalLlmSettings } =
  await import("../../../src/config/llm-config.js");

const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "OPENROUTER_API_KEY",
  "OLLAMA_API_KEY",
  "SYNAPSE_LLM_API_KEY",
  "SYNAPSE_LLM_PROVIDER",
  "SYNAPSE_LLM_MODEL",
  "SYNAPSE_LLM_BASE_URL",
];

const tmpDirs: string[] = [];

/** A project dir that looks initialized, optionally with an `llm` block. */
function makeProject(llm?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-llm-proj-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".synapse"));
  fs.writeFileSync(
    path.join(dir, ".synapse", "config.json"),
    JSON.stringify({ initialized: true, version: "1.0.0", ...(llm ? { llm } : {}) }),
  );
  return dir;
}

beforeEach(() => {
  for (const name of PROVIDER_ENV) delete process.env[name];
  fs.rmSync(TMP_GLOBAL_CONFIG, { force: true });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("resolveLlm — default", () => {
  it("stays on Anthropic with no config, and reports the missing key", () => {
    const r = resolveLlm(makeProject());
    expect(r.providerId).toBe("anthropic");
    expect(r.source).toBe("default");
    expect(r.models.generate).toMatch(/^claude-/);
    expect(r.problems.join(" ")).toContain("ANTHROPIC_API_KEY");
  });

  it("is ready once ANTHROPIC_API_KEY is present — the pre-existing flow", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const r = resolveLlm(makeProject());
    expect(r.problems).toEqual([]);
    expect(r.keySource).toBe("env");
    expect(r.apiKey).toBe("sk-ant-test");
  });
});

describe("resolveLlm — precedence", () => {
  it("project config beats global config", () => {
    writeLlmSettings("global", "", { provider: "openai" });
    const r = resolveLlm(makeProject({ provider: "groq" }));
    expect(r.providerId).toBe("groq");
    expect(r.source).toBe("project");
  });

  it("falls back to global config when the project has no block", () => {
    writeLlmSettings("global", "", { provider: "openai" });
    const r = resolveLlm(makeProject());
    expect(r.providerId).toBe("openai");
    expect(r.source).toBe("global");
  });

  it("env beats stored config", () => {
    process.env.SYNAPSE_LLM_PROVIDER = "grok";
    const r = resolveLlm(makeProject({ provider: "groq" }));
    expect(r.providerId).toBe("grok");
    expect(r.source).toBe("env");
  });

  it("flags beat env", () => {
    process.env.SYNAPSE_LLM_PROVIDER = "grok";
    const r = resolveLlm(makeProject({ provider: "groq" }), { provider: "openai" });
    expect(r.providerId).toBe("openai");
    expect(r.source).toBe("flag");
  });

  it("--anthropic-key still selects Anthropic and supplies the key", () => {
    const r = resolveLlm(makeProject({ provider: "groq" }), { anthropicKey: "sk-ant-legacy" });
    expect(r.providerId).toBe("anthropic");
    expect(r.apiKey).toBe("sk-ant-legacy");
    expect(r.keySource).toBe("flag");
    expect(r.problems).toEqual([]);
  });
});

describe("resolveLlm — models", () => {
  it("uses provider defaults for stages the config does not pin", () => {
    const r = resolveLlm(makeProject({ provider: "groq", models: { generate: "my-model" } }));
    expect(r.models.generate).toBe("my-model");
    expect(r.models.triage).toBe("llama-3.1-8b-instant");
  });

  it("a single --model pins every stage", () => {
    const r = resolveLlm(makeProject({ provider: "groq" }), { model: "one-model" });
    expect(Object.values(r.models)).toEqual(["one-model", "one-model", "one-model", "one-model"]);
  });

  it("does not inherit stored models when the flag switches provider", () => {
    // Otherwise `--provider openai` would try to run a Groq model id.
    const r = resolveLlm(
      makeProject({ provider: "groq", models: { generate: "openai/gpt-oss-120b" } }),
      { provider: "grok" },
    );
    expect(r.models.generate).toBe("grok-4.6");
  });
});

describe("resolveLlm — keys", () => {
  it("reads the provider-specific env var", () => {
    process.env.GROQ_API_KEY = "gsk-1";
    const r = resolveLlm(makeProject({ provider: "groq" }));
    expect(r.apiKey).toBe("gsk-1");
    expect(r.problems).toEqual([]);
  });

  it("accepts either env var alias for xAI", () => {
    process.env.GROK_API_KEY = "xai-1";
    expect(resolveLlm(makeProject({ provider: "grok" })).apiKey).toBe("xai-1");
  });

  it("SYNAPSE_LLM_API_KEY works as a provider-agnostic fallback", () => {
    process.env.SYNAPSE_LLM_API_KEY = "generic-1";
    expect(resolveLlm(makeProject({ provider: "openai" })).apiKey).toBe("generic-1");
  });

  it("does not demand a key for Ollama", () => {
    const r = resolveLlm(makeProject({ provider: "ollama" }));
    expect(r.problems).toEqual([]);
    expect(r.apiKey).toBeNull();
  });

  it("round-trips a saved key through the encrypted store", () => {
    writeLlmSettings("global", "", { provider: "groq" });
    const dir = makeProject();
    const { encryptApiKey } = LOCAL_STORE;
    const [prefix, encrypted] = encryptApiKey("gsk-saved-key");
    writeLlmSettings("global", dir, {
      provider: "groq",
      api_key_prefix: prefix,
      api_key_encrypted: encrypted,
    });
    const r = resolveLlm(dir);
    expect(r.apiKey).toBe("gsk-saved-key");
    expect(r.keySource).toBe("stored");
  });
});

describe("resolveLlm — custom endpoints", () => {
  it("requires a base URL and a model", () => {
    const r = resolveLlm(makeProject({ provider: "custom" }));
    expect(r.problems.join(" ")).toContain("needs an endpoint");
    expect(r.problems.join(" ")).toContain("No model configured");
  });

  it("is ready once both are supplied", () => {
    const r = resolveLlm(
      makeProject({
        provider: "custom",
        base_url: "http://gpu.internal:8000/v1",
        models: { triage: "m", generate: "m", verify: "m", fallback_generate: "m" },
      }),
    );
    expect(r.problems).toEqual([]);
    expect(r.baseUrl).toBe("http://gpu.internal:8000/v1");
  });

  it("carries capability overrides through to the resolved caps", () => {
    const r = resolveLlm(
      makeProject({
        provider: "custom",
        base_url: "http://gpu.internal:8000/v1",
        models: { triage: "m", generate: "m", verify: "m", fallback_generate: "m" },
        tool_choice: false,
        max_tokens_field: "max_completion_tokens",
        temperature: false,
        headers: { "X-Route": "a100" },
      }),
    );
    expect(r.caps.toolChoice).toBe(false);
    expect(r.caps.maxTokensField).toBe("max_completion_tokens");
    expect(r.caps.temperature).toBe(false);
    expect(r.headers["X-Route"]).toBe("a100");
  });

  it("SYNAPSE_LLM_BASE_URL overrides the stored endpoint", () => {
    process.env.SYNAPSE_LLM_BASE_URL = "http://other:9000/v1";
    const r = resolveLlm(
      makeProject({ provider: "custom", base_url: "http://gpu.internal:8000/v1", models: { triage: "m", generate: "m", verify: "m", fallback_generate: "m" } }),
    );
    expect(r.baseUrl).toBe("http://other:9000/v1");
  });
});

describe("resolveLlm — bad input", () => {
  it("reports an unknown provider from a flag as a problem, not a crash", () => {
    const r = resolveLlm(makeProject(), { provider: "gpt6" });
    expect(r.problems.join(" ")).toContain('Unknown provider "gpt6"');
  });

  it("warns and ignores a malformed stored block rather than failing the build", () => {
    const r = resolveLlm(makeProject({ provider: "groq", base_url: "not-a-url" }));
    expect(r.warnings.join(" ")).toContain("Invalid `llm` config");
    expect(r.providerId).toBe("anthropic");
  });

  it("rejects unknown keys in the schema", () => {
    const parsed = LlmSettingsSchema.safeParse({ provider: "groq", typo_field: 1 });
    expect(parsed.success).toBe(false);
  });

  it("keeps OpenRouter's attribution headers", () => {
    const r = resolveLlm(makeProject({ provider: "openrouter" }));
    expect(r.headers["X-Title"]).toBe("Synapse CLI");
  });
});

describe("writeLlmSettings", () => {
  it("persists and reads back a global block", () => {
    writeLlmSettings("global", "", { provider: "groq", models: { generate: "g" } });
    expect(readGlobalLlmSettings().settings).toEqual({
      provider: "groq",
      models: { generate: "g" },
    });
  });

  it("refuses a project write in an uninitialized directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-llm-bare-"));
    tmpDirs.push(dir);
    expect(() => writeLlmSettings("project", dir, { provider: "groq" })).toThrow(/synapse init/);
  });
});

// Imported late so the paths mock is already installed.
const LOCAL_STORE = await import("../../../src/config/api-key-store.js");
