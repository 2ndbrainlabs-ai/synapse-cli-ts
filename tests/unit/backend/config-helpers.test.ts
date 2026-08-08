// tests/unit/backend/config-helpers.test.ts
//
// Small pure helpers — resolveAnthropicKey and resolveEffectiveMode. Both
// must be deterministic and never touch disk.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  resolveAnthropicKey,
  resolveEffectiveMode,
} from "../../../src/config/manager.js";

describe("resolveAnthropicKey", () => {
  const savedEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv;
  });

  it("prefers the CLI flag over the env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    expect(resolveAnthropicKey("sk-ant-flag")).toBe("sk-ant-flag");
  });

  it("falls back to the env var when the flag is empty or nullish", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    expect(resolveAnthropicKey(null)).toBe("sk-ant-env");
    expect(resolveAnthropicKey(undefined)).toBe("sk-ant-env");
    expect(resolveAnthropicKey("")).toBe("sk-ant-env");
    expect(resolveAnthropicKey("   ")).toBe("sk-ant-env");
  });

  it("returns null when neither flag nor env is set", () => {
    expect(resolveAnthropicKey(null)).toBeNull();
  });

  it("trims whitespace off flag and env values", () => {
    process.env.ANTHROPIC_API_KEY = "   sk-ant-env-padded   ";
    expect(resolveAnthropicKey(null)).toBe("sk-ant-env-padded");
    expect(resolveAnthropicKey("   sk-ant-flag-padded   ")).toBe("sk-ant-flag-padded");
  });
});

describe("resolveEffectiveMode", () => {
  it("CLI --local overrides config mode", () => {
    expect(resolveEffectiveMode("hosted", true)).toBe("local");
    expect(resolveEffectiveMode("local", true)).toBe("local");
    expect(resolveEffectiveMode(undefined, true)).toBe("local");
  });

  it("config mode wins when no CLI flag is set", () => {
    expect(resolveEffectiveMode("local", false)).toBe("local");
    expect(resolveEffectiveMode("hosted", false)).toBe("hosted");
  });

  it("defaults to hosted when config is missing and no flag", () => {
    expect(resolveEffectiveMode(undefined, false)).toBe("hosted");
  });
});
