// `synapse analyze` reports its outcome in telemetry (SYN-321): success=true
// when it completes, success=false + error_code when it fails — like build.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  failAnalyze: false,
  trackEvent: null as null | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("../../../src/grpc/telemetry.js", () => ({
  trackEvent: (...args: unknown[]) => state.trackEvent!(...args),
  checkQuota: async () => [false, ""],
  isQuotaExceeded: () => false,
}));

vi.mock("../../../src/analyzer/codebase-analyzer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/analyzer/codebase-analyzer.js")>();
  return {
    ...actual,
    analyzeCodebase: (dir: string) => {
      if (state.failAnalyze) throw new Error("parser exploded");
      return actual.analyzeCodebase(dir);
    },
  };
});

import { ANALYZE_FAILED, runAnalyze } from "../../../src/commands/analyze.js";

describe("analyze telemetry outcome", () => {
  const savedKey = process.env.SYNAPSE_API_KEY;
  let project: string;
  let trackEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-analyze-"));
    fs.mkdirSync(path.join(project, ".synapse"));
    fs.writeFileSync(path.join(project, ".synapse", "config.json"), JSON.stringify({ initialized: true }));
    fs.writeFileSync(path.join(project, "app.py"), "def hello(name):\n    return name\n");
    vi.spyOn(process, "cwd").mockReturnValue(project);
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.SYNAPSE_API_KEY = "syn_env_key";
    state.failAnalyze = false;
    trackEvent = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    state.trackEvent = trackEvent as unknown as (...args: unknown[]) => Promise<unknown>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(project, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.SYNAPSE_API_KEY;
    else process.env.SYNAPSE_API_KEY = savedKey;
  });

  it("sends success=true with the lines analyzed", async () => {
    await runAnalyze(".synapse", false);
    await vi.waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(1));
    const [eventType, apiKey, , lines, , , , mode, outcome] = trackEvent.mock.calls[0];
    expect(eventType).toBe("analyze");
    expect(apiKey).toBe("syn_env_key");
    expect(lines).toBeGreaterThan(0);
    expect(mode).toBe("hosted");
    expect(outcome).toEqual({ success: true });
  });

  it("sends success=false and an error code when analysis fails", async () => {
    state.failAnalyze = true;
    await runAnalyze(".synapse", false);
    await vi.waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(1));
    const [eventType, , , , , , , , outcome] = trackEvent.mock.calls[0];
    expect(eventType).toBe("analyze");
    expect(outcome).toEqual({ success: false, errorCode: ANALYZE_FAILED });
  });
});
