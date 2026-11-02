// The v1 engine (`synapse build --engine v1`) used to send a `build` event
// only after a successful build with tools, so its failures never reached
// telemetry. Every run now sends exactly one event; exit codes are unchanged.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  build: null as unknown as (...args: unknown[]) => Promise<unknown>,
  trackEvent: null as unknown as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock("../../../src/grpc/client.js", () => ({
  SynapseClient: class {
    build(...args: unknown[]) {
      return mocks.build(...args);
    }
  },
}));

vi.mock("../../../src/grpc/telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/grpc/telemetry.js")>();
  return {
    ...actual,
    checkQuota: async () => [false, ""],
    trackEvent: (...args: unknown[]) => mocks.trackEvent(...args),
  };
});

import { runBuild } from "../../../src/commands/build.js";

describe("v1 build telemetry", () => {
  const savedEnv = { ...process.env };
  let project: string;
  let trackEvent: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  const opts = { query: "Create tools for patient lookups", output: "mcp_server.py", validate: false, docs: false, generateOnly: false };

  function init(withSchema = true): void {
    fs.mkdirSync(path.join(project, ".synapse"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".synapse", "config.json"),
      JSON.stringify({ initialized: true, version: "1.0.0", mode: "hosted" }),
    );
    if (withSchema) fs.writeFileSync(path.join(project, ".synapse", "project_schema.txt"), "schema");
  }

  /** [toolCount, mode, outcome] of the single build event. */
  function buildEvent(): unknown[] {
    expect(trackEvent).toHaveBeenCalledTimes(1);
    const args = trackEvent.mock.calls[0];
    expect(args[0]).toBe("build");
    expect(args[1]).toBe("syn_test_key");
    return [args[4], args[7], args[8]];
  }

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-v1-"));
    vi.spyOn(process, "cwd").mockReturnValue(project);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.SYNAPSE_API_KEY = "syn_test_key";
    process.env.SYNAPSE_NON_INTERACTIVE = "1";
    process.exitCode = undefined;
    mocks.build = vi.fn();
    trackEvent = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ ok: true, status: 200 });
    mocks.trackEvent = trackEvent;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    process.env = { ...savedEnv };
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("reports NOT_INITIALIZED", async () => {
    await runBuild(opts);
    expect(buildEvent()[2]).toMatchObject({ success: false, errorCode: "NOT_INITIALIZED" });
    expect(process.exitCode).toBeUndefined();
  });

  it("reports ANALYSIS_REQUIRED when there is no project schema", async () => {
    init(false);
    await runBuild(opts);
    expect(buildEvent()[2]).toMatchObject({ success: false, errorCode: "ANALYSIS_REQUIRED" });
  });

  it("reports BUILD_FAILED when the backend build fails", async () => {
    init();
    mocks.build = vi.fn().mockResolvedValue({ success: false, error: "nope" });
    await runBuild(opts);
    expect(buildEvent()[2]).toMatchObject({ success: false, errorCode: "BUILD_FAILED", language: "python" });
  });

  it("reports BUILD_ERROR when the backend call throws", async () => {
    init();
    mocks.build = vi.fn().mockRejectedValue(new Error("14 UNAVAILABLE"));
    await runBuild(opts);
    expect(buildEvent()[2]).toMatchObject({ success: false, errorCode: "BUILD_ERROR" });
  });

  it("reports a success with the tool count", async () => {
    init();
    mocks.build = vi.fn().mockResolvedValue({ success: true, serverCode: "print(1)\n", toolCount: 3 });
    await runBuild(opts);
    const [toolCount, mode, outcome] = buildEvent();
    expect(toolCount).toBe(3);
    expect(mode).toBe("hosted");
    expect(outcome).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(project, "mcp_server.py"))).toBe(true);
  });
});
