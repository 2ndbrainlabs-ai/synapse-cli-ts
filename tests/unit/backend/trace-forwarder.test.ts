// tests/unit/backend/trace-forwarder.test.ts
//
// The forwarder must:
//  1. Be fire-and-forget (never throw on network failure).
//  2. Respect SYNAPSE_TELEMETRY=0.
//  3. Never send prompt bodies or generated code — only metadata.
//  4. Cache a stable installation_id.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  forwardTrace,
  installationId,
} from "../../../src/backend/trace-forwarder.js";

function baseRecord() {
  return {
    installation_id: "test-install",
    mode: "local" as const,
    cli_version: "0.0.0-test",
    session_id: "sess_test",
    stage: "shape",
    model: "claude-haiku-4-5",
    input_tokens: 100,
    output_tokens: 50,
    duration_ms: 250,
    attempt: 1,
    success: true,
    error_class: null,
    prompt_hash: "abc123",
    response_schema: "ToolPlan",
  };
}

describe("installationId()", () => {
  it("returns a stable hash across calls in the same process", () => {
    const a = installationId();
    const b = installationId();
    expect(a).toBe(b);
    // 64-hex-char sha256 output
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("forwardTrace()", () => {
  const savedTelemetry = process.env.SYNAPSE_TELEMETRY;
  const savedFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.SYNAPSE_TELEMETRY;
  });
  afterEach(() => {
    if (savedTelemetry === undefined) delete process.env.SYNAPSE_TELEMETRY;
    else process.env.SYNAPSE_TELEMETRY = savedTelemetry;
    globalThis.fetch = savedFetch;
  });

  it("short-circuits when SYNAPSE_TELEMETRY=0 (no fetch call at all)", async () => {
    process.env.SYNAPSE_TELEMETRY = "0";
    const spy = vi.fn(async () => new Response("ok"));
    globalThis.fetch = spy as unknown as typeof fetch;

    await forwardTrace(baseRecord());
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts to /telemetry/llm-trace with metadata-only body", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    await forwardTrace(baseRecord());
    expect(capturedUrl).toContain("/telemetry/llm-trace");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body));
    // Must-have metadata fields.
    expect(body.installation_id).toBe("test-install");
    expect(body.mode).toBe("local");
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.input_tokens).toBe(100);
    expect(body.output_tokens).toBe(50);
    // Must NOT leak prompt or code content.
    expect(JSON.stringify(body)).not.toMatch(/sk-ant/);
    expect(body).not.toHaveProperty("prompt");
    expect(body).not.toHaveProperty("prompt_body");
    expect(body).not.toHaveProperty("response");
    expect(body).not.toHaveProperty("response_body");
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("body_source");
    expect(body).not.toHaveProperty("messages");
  });

  it("swallows network errors silently (fire-and-forget contract)", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    // If this throws, the test fails.
    await expect(forwardTrace(baseRecord())).resolves.toBeUndefined();
  });
});
