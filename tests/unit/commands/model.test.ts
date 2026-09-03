// `synapse model set|reset` — what it writes, and what it refuses to write.
//
// Asserts the persisted config rather than the console output: the config is
// the durable contract that a later build reads, and rendering is free to
// change. Console is captured only to keep test output readable.
//
// HOME and cwd are redirected so the developer's real config is never touched.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-model-home-"));
const TMP_GLOBAL_DIR = path.join(TMP_HOME, ".synapse");

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  return {
    ...actual,
    GLOBAL_SYNAPSE_DIR: TMP_GLOBAL_DIR,
    GLOBAL_CONFIG_PATH: path.join(TMP_GLOBAL_DIR, "config.json"),
  };
});

const { runModelSet, runModelReset } = await import("../../../src/commands/model.js");

const dirs: string[] = [];
let cwd: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function projectConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".synapse", "config.json"), "utf-8"));
}

function llm(): Record<string, unknown> | undefined {
  return projectConfig().llm as Record<string, unknown> | undefined;
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-model-proj-"));
  dirs.push(cwd);
  fs.mkdirSync(path.join(cwd, ".synapse"));
  fs.writeFileSync(
    path.join(cwd, ".synapse", "config.json"),
    JSON.stringify({ initialized: true, version: "1.0.0" }),
  );
  fs.rmSync(path.join(TMP_GLOBAL_DIR, "config.json"), { force: true });
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  cwdSpy.mockRestore();
  logSpy.mockRestore();
});

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("model set — persistence", () => {
  it("writes just the provider when defaults suffice", () => {
    runModelSet("groq", {});
    expect(llm()).toEqual({ provider: "groq" });
  });

  it("keeps the rest of the project config intact", () => {
    runModelSet("groq", {});
    const cfg = projectConfig();
    expect(cfg.initialized).toBe(true);
    expect(cfg.version).toBe("1.0.0");
  });

  it("pins every stage from a single --model", () => {
    runModelSet("groq", { model: "one-model" });
    expect(llm()!.models).toEqual({
      triage: "one-model",
      generate: "one-model",
      verify: "one-model",
      fallback_generate: "one-model",
    });
  });

  it("records only the stages named individually", () => {
    runModelSet("groq", { generate: "big", triage: "small" });
    expect(llm()!.models).toEqual({ generate: "big", triage: "small" });
  });

  it("lets a per-stage flag win over --model", () => {
    runModelSet("groq", { model: "base", verify: "special" });
    const models = llm()!.models as Record<string, string>;
    expect(models.verify).toBe("special");
    expect(models.generate).toBe("base");
  });

  it("merges repeated --header flags", () => {
    runModelSet("custom", {
      baseUrl: "http://x.test/v1",
      model: "m",
      header: ["X-A: 1", "X-B: two words"],
    });
    expect(llm()!.headers).toEqual({ "X-A": "1", "X-B": "two words" });
  });

  it("keeps a header value containing a colon", () => {
    runModelSet("custom", {
      baseUrl: "http://x.test/v1",
      model: "m",
      header: ["X-Url: http://a.test/b"],
    });
    expect((llm()!.headers as Record<string, string>)["X-Url"]).toBe("http://a.test/b");
  });

  it("stores capability overrides for a partially-compatible endpoint", () => {
    runModelSet("custom", {
      baseUrl: "http://x.test/v1",
      model: "m",
      noToolChoice: true,
      maxCompletionTokens: true,
      noTemperature: true,
    });
    const block = llm()!;
    expect(block.tool_choice).toBe(false);
    expect(block.max_tokens_field).toBe("max_completion_tokens");
    expect(block.temperature).toBe(false);
  });

  it("omits capability keys that were not overridden", () => {
    runModelSet("groq", {});
    const block = llm()!;
    expect(block).not.toHaveProperty("tool_choice");
    expect(block).not.toHaveProperty("temperature");
    expect(block).not.toHaveProperty("max_tokens_field");
  });

  it("encrypts a --save-key and never stores it in cleartext", () => {
    runModelSet("groq", { saveKey: "gsk_supersecret_value" });
    const block = llm()!;
    expect(block.api_key_prefix).toBe("gsk_s");
    expect(String(block.api_key_encrypted).length).toBeGreaterThan(20);
    const raw = fs.readFileSync(path.join(cwd, ".synapse", "config.json"), "utf-8");
    expect(raw).not.toContain("supersecret");
  });

  it("writes to the global config with --global, leaving the project alone", () => {
    runModelSet("groq", { globalScope: true });
    const global = JSON.parse(
      fs.readFileSync(path.join(TMP_GLOBAL_DIR, "config.json"), "utf-8"),
    );
    expect(global.llm).toEqual({ provider: "groq" });
    expect(llm()).toBeUndefined();
  });
});

describe("model set — switching providers", () => {
  it("keeps accumulating settings for the same provider", () => {
    runModelSet("groq", { generate: "big" });
    runModelSet("groq", { triage: "small" });
    expect(llm()!.models).toEqual({ generate: "big", triage: "small" });
  });

  it("drops the previous provider's models on switch", () => {
    // A Groq model id is meaningless to OpenAI; inheriting it would send a
    // request that fails at the provider for no obvious reason.
    runModelSet("groq", { model: "openai/gpt-oss-120b" });
    runModelSet("openai", {});
    expect(llm()).toEqual({ provider: "openai" });
  });

  it("drops the previous provider's capability overrides on switch", () => {
    runModelSet("custom", { baseUrl: "http://x.test/v1", model: "m", noToolChoice: true });
    runModelSet("groq", {});
    expect(llm()).not.toHaveProperty("tool_choice");
  });

  it("drops a stored key on switch rather than sending it elsewhere", () => {
    runModelSet("groq", { saveKey: "gsk_secret" });
    runModelSet("openai", {});
    expect(llm()).not.toHaveProperty("api_key_encrypted");
  });
});

describe("model set — refusals", () => {
  it("rejects an unknown provider and writes nothing", () => {
    runModelSet("gpt6", {});
    expect(llm()).toBeUndefined();
  });

  it("rejects custom with no endpoint", () => {
    runModelSet("custom", { model: "m" });
    expect(llm()).toBeUndefined();
  });

  it("rejects custom with no model", () => {
    runModelSet("custom", { baseUrl: "http://x.test/v1" });
    expect(llm()).toBeUndefined();
  });

  it("rejects a malformed base URL", () => {
    runModelSet("custom", { baseUrl: "not a url", model: "m" });
    expect(llm()).toBeUndefined();
  });

  it("rejects a malformed --header and writes nothing", () => {
    runModelSet("groq", { header: ["no-colon-here"] });
    expect(llm()).toBeUndefined();
  });

  it("leaves an existing config untouched when a later set is rejected", () => {
    runModelSet("groq", { generate: "big" });
    runModelSet("custom", { model: "m" }); // no base URL — refused
    expect(llm()).toEqual({ provider: "groq", models: { generate: "big" } });
  });

  it("refuses a project write in an uninitialized directory", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-model-bare-"));
    dirs.push(bare);
    cwdSpy.mockReturnValue(bare);
    runModelSet("groq", {});
    expect(fs.existsSync(path.join(bare, ".synapse", "config.json"))).toBe(false);
  });
});

describe("model reset", () => {
  it("removes the llm block but keeps the rest of the config", () => {
    runModelSet("groq", { model: "m", saveKey: "gsk_secret" });
    runModelReset({});
    expect(llm()).toBeUndefined();
    expect(projectConfig().initialized).toBe(true);
  });

  it("clears the global block with --global", () => {
    runModelSet("groq", { globalScope: true });
    runModelReset({ globalScope: true });
    const global = JSON.parse(
      fs.readFileSync(path.join(TMP_GLOBAL_DIR, "config.json"), "utf-8"),
    );
    expect(global.llm).toBeUndefined();
  });

  it("is safe to call when nothing is configured", () => {
    expect(() => runModelReset({})).not.toThrow();
    expect(llm()).toBeUndefined();
  });
});
