// `synapse build` exit codes and the build telemetry outcome (SYN-314).
//
// A failed or aborted build used to print an error and exit 0, and every run
// sent a plain `build` event. Each scenario here runs runBuildV2 end to end
// with the extractor, backend clients and telemetry mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HttpEndpoint, SurfaceManifest } from "../../../src/extractors/core/surface-manifest.js";

const mocks = vi.hoisted(() => ({
  manifest: null as unknown,
  buildCustom: null as unknown as (...args: unknown[]) => Promise<unknown>,
  createMcpServer: null as unknown as (...args: unknown[]) => Promise<unknown>,
  batchCreateEndpoints: null as unknown as (...args: unknown[]) => Promise<unknown>,
  trackEvent: null as unknown as (...args: unknown[]) => Promise<void>,
}));

vi.mock("../../../src/extractors/core/extractor.js", () => ({
  extractSurfaceStreamed: async () => mocks.manifest,
}));

vi.mock("../../../src/grpc/client-factory.js", () => ({
  makeSynapseClient: () => ({
    buildCustom: (...args: unknown[]) => mocks.buildCustom(...args),
  }),
}));

vi.mock("../../../src/backend/ui-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/backend/ui-client.js")>();
  return {
    ...actual,
    createMcpServer: (...args: unknown[]) => mocks.createMcpServer(...args),
    batchCreateEndpoints: (...args: unknown[]) => mocks.batchCreateEndpoints(...args),
  };
});

vi.mock("../../../src/grpc/telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/grpc/telemetry.js")>();
  return { ...actual, trackEvent: (...args: unknown[]) => mocks.trackEvent(...args) };
});

import { runBuildV2 } from "../../../src/commands/v2/build-v2.js";
import { readLedger } from "../../../src/session/ledger.js";
import { readCliVersion } from "../../../src/utils/version.js";

function ep(method: HttpEndpoint["method"], p: string, tool: string): HttpEndpoint {
  return {
    method,
    path: p,
    handler_module: "app.main",
    handler_qualname: tool,
    description: "",
    payload_example: null,
    headers_hint: [],
    suggested_tool_name: tool,
    file_path: "app/main.py",
    start_line: 1,
    end_line: 2,
  };
}

function manifest(): SurfaceManifest {
  return {
    language: "python",
    framework: "fastapi",
    package_import_root: "app",
    endpoints: [
      ep("GET", "/patients", "list_patients"),
      ep("POST", "/patients", "create_patient"),
      ep("GET", "/patients/{id}", "get_patient"),
    ],
    functions: [
      {
        module: "app.svc",
        qualname: "risk_score",
        signature: "def risk_score(pid: str) -> float",
        docstring: "",
        is_async: false,
        is_public: true,
        file_path: "app/svc.py",
        start_line: 1,
        end_line: 5,
      },
    ],
  };
}

function customResult(over: Record<string, unknown>) {
  return {
    success: false,
    tool_name: "",
    file_extension: "",
    file_source: "",
    env_vars: [],
    report_json: "",
    error: "",
    sessionId: "s",
    ...over,
  };
}

describe("synapse build exit codes", () => {
  const savedEnv = { ...process.env };
  let project: string;
  let printed: string[];
  let trackEvent: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;

  function output(): string {
    return printed.join(" ").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
  }

  /** The single `build` event's [toolCount, candidateCount, durationMs, mode, outcome]. */
  async function buildEvent(): Promise<unknown[]> {
    await vi.waitFor(() => expect(trackEvent).toHaveBeenCalledTimes(1));
    const args = trackEvent.mock.calls[0];
    expect(args[0]).toBe("build");
    return args.slice(4);
  }

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-build-"));
    fs.mkdirSync(path.join(project, ".synapse"));
    fs.writeFileSync(
      path.join(project, ".synapse", "config.json"),
      JSON.stringify({ initialized: true, version: "1.0.0", mode: "hosted" }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(project);
    printed = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    process.env.SYNAPSE_API_KEY = "syn_test_key";
    process.env.SYNAPSE_NON_INTERACTIVE = "1";
    process.exitCode = undefined;

    mocks.manifest = manifest();
    mocks.buildCustom = vi.fn();
    mocks.createMcpServer = vi.fn().mockResolvedValue({ server: { id: "srv_1", name: "x", description: null } });
    mocks.batchCreateEndpoints = vi.fn().mockResolvedValue({ endpoints: [] });
    trackEvent = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    mocks.trackEvent = trackEvent;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    process.env = { ...savedEnv };
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("exits non-zero when the custom composition fails, without claiming success first", async () => {
    mocks.buildCustom = vi.fn().mockResolvedValue(
      customResult({
        error: JSON.stringify({
          error_code: "LLM_OUTPUT_INVALID",
          user_message: "ToolShaper couldn't produce a valid plan after retries.",
          technical: "TypeError: AsyncMessages.create() got an unexpected keyword argument 'temperature'",
          hint: "re-run",
          missing_fields: [],
          extra: {},
        }),
      }),
    );
    await runBuildV2({ custom: true, query: "score patients" });

    expect(process.exitCode).toBe(1);
    const out = output();
    expect(out).toMatch(/Composition Failed/);
    expect(out).toMatch(/The Synapse server hit an internal error/);
    expect(out).not.toMatch(/LLM_OUTPUT_INVALID/);
    expect(out).not.toMatch(/Generation complete/);

    const [toolCount, candidateCount, durationMs, mode, outcome] = await buildEvent();
    expect(toolCount).toBe(0);
    expect(candidateCount).toBe(1);
    expect(typeof durationMs).toBe("number");
    expect(mode).toBe("hosted");
    expect(outcome).toEqual({ success: false, errorCode: "SERVER_ERROR", language: "python" });
  });

  it("exits non-zero with the invalid-key message on gRPC UNAUTHENTICATED", async () => {
    mocks.buildCustom = vi
      .fn()
      .mockResolvedValue(customResult({ error: "gRPC error: 16: Invalid or expired API key" }));
    await runBuildV2({ custom: true, query: "score patients" });

    expect(process.exitCode).toBe(1);
    const out = output();
    expect(out).toMatch(/Your Synapse API key is invalid or expired/);
    expect(out).toMatch(/AUTH_INVALID/);
    expect(out).toMatch(/SYNAPSE_API_KEY/);
    const [, , , , outcome] = await buildEvent();
    expect(outcome).toMatchObject({ success: false, errorCode: "AUTH_INVALID" });
  });

  it("exits non-zero when the backend is unreachable", async () => {
    mocks.buildCustom = vi
      .fn()
      .mockResolvedValue(customResult({ error: "gRPC error: 14: No connection established" }));
    await runBuildV2({ custom: true, query: "score patients" });

    expect(process.exitCode).toBe(1);
    expect(output()).toMatch(/Couldn't reach the Synapse backend/);
    const [, , , , outcome] = await buildEvent();
    expect(outcome).toMatchObject({ errorCode: "BACKEND_UNAVAILABLE" });
  });

  it("exits non-zero with the server's quota message on a gRPC quota rejection (SYN-317)", async () => {
    const quotaMsg = "Lines quota exceeded (1200/1000). Contact synaps3.ai for extended limits.";
    mocks.buildCustom = vi
      .fn()
      .mockResolvedValue(customResult({ error: `gRPC error: 8: ${quotaMsg}` }));
    await runBuildV2({ custom: true, query: "score patients" });

    expect(mocks.buildCustom).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    const out = output();
    expect(out).toContain(quotaMsg);
    expect(out).toMatch(/QUOTA_EXCEEDED/);
    expect(out).not.toMatch(/attempts/);
    const [, , , , outcome] = await buildEvent();
    expect(outcome).toMatchObject({ success: false, errorCode: "QUOTA_EXCEEDED" });
  });

  it("exits 0 and reports success with one tool for a custom build that writes a file", async () => {
    mocks.buildCustom = vi.fn().mockResolvedValue(
      customResult({
        success: true,
        tool_name: "risk",
        file_extension: "py",
        file_source: "print('ok')\n",
      }),
    );
    await runBuildV2({ custom: true, query: "score patients" });

    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(project, "risk_server.py"))).toBe(true);
    const [toolCount, , , , outcome] = await buildEvent();
    expect(toolCount).toBe(1);
    expect(outcome).toEqual({ success: true, errorCode: undefined, language: "python" });
  });

  it("--auto without a terminal or selection flag exits non-zero with a clear message", async () => {
    await runBuildV2({ auto: true });

    expect(process.exitCode).toBe(1);
    expect(output()).toMatch(/Endpoint Selection Required/);
    expect(mocks.createMcpServer).not.toHaveBeenCalled();
    const [toolCount, candidateCount, , , outcome] = await buildEvent();
    expect(toolCount).toBe(0);
    expect(candidateCount).toBe(3);
    expect(outcome).toMatchObject({ success: false, errorCode: "ENDPOINT_SELECTION_REQUIRED" });
  });

  it("--endpoints works without a terminal and counts the selected endpoints as tools", async () => {
    await runBuildV2({ endpoints: "GET /patients,get_patient" });

    expect(process.exitCode).toBeUndefined();
    const batch = (mocks.batchCreateEndpoints as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      endpoints: unknown[];
    };
    expect(batch.endpoints).toHaveLength(2);
    const [toolCount, candidateCount, , , outcome] = await buildEvent();
    expect(toolCount).toBe(2);
    expect(candidateCount).toBe(3);
    expect(outcome).toMatchObject({ success: true, language: "python" });
  });

  it("--all-endpoints selects every endpoint", async () => {
    await runBuildV2({ auto: true, allEndpoints: true });
    expect(process.exitCode).toBeUndefined();
    const [toolCount] = await buildEvent();
    expect(toolCount).toBe(3);
  });

  it("exits non-zero with the invalid-key message when the ui-backend returns 401", async () => {
    const { UiBackendError } = await import("../../../src/backend/ui-client.js");
    mocks.createMcpServer = vi.fn().mockRejectedValue(new UiBackendError(401, "Invalid API key"));
    await runBuildV2({ auto: true, allEndpoints: true });

    expect(process.exitCode).toBe(1);
    expect(output()).toMatch(/Your Synapse API key is invalid or expired/);
    const [, , , , outcome] = await buildEvent();
    expect(outcome).toMatchObject({ success: false, errorCode: "AUTH_INVALID" });
  });

  it("exits non-zero when no endpoints are detected", async () => {
    mocks.manifest = { ...manifest(), endpoints: [] };
    await runBuildV2({ auto: true, allEndpoints: true });
    expect(process.exitCode).toBe(1);
    const [, , , , outcome] = await buildEvent();
    expect(outcome).toMatchObject({ errorCode: "NO_ENDPOINTS" });
  });

  it("exits non-zero when the project isn't initialized", async () => {
    fs.rmSync(path.join(project, ".synapse"), { recursive: true });
    await runBuildV2({ auto: true, allEndpoints: true });
    expect(process.exitCode).toBe(1);
    const [, , , , outcome] = await buildEvent();
    expect(outcome).toMatchObject({ success: false, errorCode: "NOT_INITIALIZED" });
  });

  it("records the real CLI version in the session ledger", async () => {
    await runBuildV2({ auto: true, allEndpoints: true });
    const dir = path.join(project, ".synapse", "discover");
    const [ledgerFile] = fs.readdirSync(dir);
    const events = readLedger(project, ledgerFile.replace(/\.jsonl$/, ""));
    const opened = events.find((e) => e.type === "session_open");
    expect(opened?.type === "session_open" && opened.cli_version).toBe(readCliVersion());
    expect(readCliVersion()).not.toBe("dev");
  });
});
