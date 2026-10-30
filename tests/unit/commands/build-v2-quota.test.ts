// v2 hosted builds count indexed lines and enforce the lines quota (SYN-315).
//
// Runs the real v2 extractor over a temp Python repo of exactly 1,000 lines
// and stubs only the network (`fetch`) and the code-generation flows, so the
// assertions cover what actually goes over the wire: the pre-flight
// GET /quota, the `analyze` line-count event and the `build` analytics event.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-v2-quota-home-"));
const TMP_GLOBAL_DIR = path.join(TMP_HOME, ".synapse");

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  return {
    ...actual,
    GLOBAL_SYNAPSE_DIR: TMP_GLOBAL_DIR,
    GLOBAL_CONFIG_PATH: path.join(TMP_GLOBAL_DIR, "config.json"),
  };
});

const flows = vi.hoisted(() => ({
  runAutoFlow: vi.fn(async () => {}),
  runLocalAutoFlow: vi.fn(async () => {}),
  runCustomFlow: vi.fn(async () => {}),
}));
vi.mock("../../../src/commands/v2/auto-flow.js", () => ({ runAutoFlow: flows.runAutoFlow }));
vi.mock("../../../src/commands/v2/local-auto-flow.js", () => ({
  runLocalAutoFlow: flows.runLocalAutoFlow,
}));
vi.mock("../../../src/commands/v2/custom-flow.js", () => ({ runCustomFlow: flows.runCustomFlow }));

// Local mode only needs a resolvable model; no provider is ever called.
vi.mock("../../../src/config/llm-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/llm-config.js")>();
  return {
    ...actual,
    resolveLlm: () => ({
      warnings: [],
      problems: [],
      label: "Test provider",
      models: { generate: "test-model", triage: "test-model" },
    }),
  };
});

const { runBuildV2 } = await import("../../../src/commands/v2/build-v2.js");

const API = "https://api.example.test";
const FAKE_KEY = "syn_live_test_00000000000000000000";
const QUOTA_MSG = "Lines analyzed quota exceeded. Contact synaps3.ai for extended limits.";

type Reply = { status: number; body?: unknown };
interface Server {
  quota: Reply;
  analyze: Reply[];
}

let server: Server;
let fetchMock: ReturnType<typeof vi.fn>;
let cwd: string;
let output: string;
const saved = { ...process.env };

function reply(r: Reply): Response {
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
}

function calls(): Array<{ url: string; method: string; body: Record<string, unknown> | null }> {
  return fetchMock.mock.calls.map(([url, init]) => {
    const i = (init ?? {}) as RequestInit;
    return {
      url: String(url),
      method: i.method ?? "GET",
      body: i.body ? (JSON.parse(String(i.body)) as Record<string, unknown>) : null,
    };
  });
}
const quotaCalls = () => calls().filter((c) => c.url === `${API}/quota`);
const events = (type: string) =>
  calls().filter((c) => c.url === `${API}/telemetry/cli` && c.body?.event_type === type);

/** Wait for the fire-and-forget `build` event runBuildV2 sends (SYN-314). */
async function buildEvent(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(events("build")).toHaveLength(1));
  return events("build")[0].body!;
}

const prevPath = () => path.join(cwd, ".synapse", "statistics.prev.json");
const baseline = (n: number) => ({
  lines_indexed: n,
  total_lines_analyzed: n,
  v2_lines_indexed: n,
});
const prevFile = () => (fs.existsSync(prevPath()) ? fs.readFileSync(prevPath(), "utf-8") : null);

/** A FastAPI app of exactly `n` lines (trailing newline included). */
function writeRepo(dir: string, n: number): void {
  const head = [
    "from fastapi import FastAPI",
    "",
    "app = FastAPI()",
    "",
    "",
    '@app.get("/orders/{order_id}")',
    "def get_order(order_id: str):",
    '    """Fetch one order."""',
    '    return {"id": order_id}',
    "",
  ];
  const pad = Array.from({ length: n - head.length }, (_, i) => `# filler line ${i}`);
  fs.writeFileSync(path.join(dir, "main.py"), [...head, ...pad].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\n");
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-v2-quota-"));
  writeRepo(cwd, 1000);
  fs.mkdirSync(path.join(cwd, ".synapse"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".synapse", "config.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);

  process.env.SYNAPSE_API_URL = API;
  process.env.SYNAPSE_API_KEY = FAKE_KEY;
  process.env.SYNAPSE_DISABLE_WORKERS = "1";
  delete process.env.SYNAPSE_TELEMETRY;
  process.exitCode = undefined;

  server = { quota: { status: 200, body: { quota_exceeded: false } }, analyze: [] };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${API}/quota`) return reply(server.quota);
    const body = JSON.parse(String(init?.body ?? "{}")) as { event_type?: string };
    if (body.event_type === "analyze") return reply(server.analyze.shift() ?? { status: 200 });
    return reply({ status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  output = "";
  const capture = (...args: unknown[]) => {
    output += args.map(String).join(" ") + "\n";
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });

  flows.runAutoFlow.mockReset().mockResolvedValue(undefined);
  flows.runLocalAutoFlow.mockReset().mockResolvedValue(undefined);
  flows.runCustomFlow.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(cwd, { recursive: true, force: true });
  process.exitCode = undefined;
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("v2 hosted build: lines quota (SYN-315)", () => {
  it("checks the quota, then sends one analyze event with lines_count=1000", async () => {
    await runBuildV2({ auto: true });

    expect(quotaCalls()).toHaveLength(1);
    const analyze = events("analyze");
    expect(analyze).toHaveLength(1);
    expect(analyze[0].method).toBe("POST");
    expect(analyze[0].body).toMatchObject({ lines_count: 1000, mode: "hosted" });
    expect(flows.runAutoFlow).toHaveBeenCalledTimes(1);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1000));
    expect(process.exitCode).toBeUndefined();
  });

  it("sends no analyze event on a rebuild with no changes", async () => {
    await runBuildV2({ auto: true });
    fetchMock.mockClear();

    await runBuildV2({ auto: true });

    expect(events("analyze")).toHaveLength(0);
    expect(flows.runAutoFlow).toHaveBeenCalledTimes(2);
  });

  it("sends only the delta after lines are added", async () => {
    await runBuildV2({ auto: true });
    writeRepo(cwd, 1250);
    fetchMock.mockClear();

    await runBuildV2({ auto: true });

    expect(events("analyze").map((e) => e.body?.lines_count)).toEqual([250]);
  });

  it("blocks the build with the quota message when the server answers 429", async () => {
    server.analyze.push({ status: 429, body: { detail: QUOTA_MSG } });

    await runBuildV2({ auto: true });

    expect(output).toContain("Quota Exceeded");
    expect(output).toContain(QUOTA_MSG);
    expect(flows.runAutoFlow).not.toHaveBeenCalled();
    expect(prevFile()).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(await buildEvent()).toMatchObject({ success: false, error_code: "QUOTA_EXCEEDED" });
  });

  it("blocks the build before extraction when the pre-flight check says exceeded", async () => {
    server.quota = { status: 200, body: { quota_exceeded: true, quota_message: QUOTA_MSG } };

    await runBuildV2({ auto: true });

    expect(output).toContain(QUOTA_MSG);
    expect(events("analyze")).toHaveLength(0);
    expect(flows.runAutoFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(await buildEvent()).toMatchObject({ success: false, error_code: "QUOTA_EXCEEDED" });
  });

  it("fails open when the pre-flight check is unreachable", async () => {
    server.quota = { status: 503, body: { detail: "unavailable" } };

    await runBuildV2({ auto: true });

    expect(flows.runAutoFlow).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps statistics.prev.json unchanged after a 500 and resends the lines next run", async () => {
    server.analyze.push({ status: 500, body: { detail: "boom" } });

    await runBuildV2({ auto: true });

    // Fails open: the build still runs, but the baseline does not move.
    expect(flows.runAutoFlow).toHaveBeenCalledTimes(1);
    expect(prevFile()).toBeNull();
    expect(process.exitCode).toBeUndefined();

    fetchMock.mockClear();
    await runBuildV2({ auto: true });
    expect(events("analyze").map((e) => e.body?.lines_count)).toEqual([1000]);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1000));
  });

  it("keeps the baseline after a failed send even when one exists", async () => {
    await runBuildV2({ auto: true });
    const before = prevFile();
    writeRepo(cwd, 1400);
    server.analyze.push({ status: 401, body: { detail: "Invalid API key" } });

    await runBuildV2({ auto: true });

    expect(prevFile()).toBe(before);
  });

  it("treats the server's rate-limit 429 as transient, not as a quota block", async () => {
    server.analyze.push({ status: 429, body: { detail: "Rate limit exceeded" } });

    await runBuildV2({ auto: true });

    expect(flows.runAutoFlow).toHaveBeenCalledTimes(1);
    expect(output).not.toContain("Quota Exceeded");
    expect(prevFile()).toBeNull();
    expect(process.exitCode).toBeUndefined();
  });

  it("sends exactly one build event, with success=true and no line count", async () => {
    await runBuildV2({ auto: true });

    const build = await buildEvent();
    expect(build).toMatchObject({ success: true, mode: "hosted" });
    expect(build).not.toHaveProperty("lines_count");
    expect(build).not.toHaveProperty("error_code");
  });
});

// Every hosted build shares one baseline per repo, including the one an
// older CLI's `synapse analyze` left behind (`total_lines_analyzed`), so the
// same lines are charged once (SYN-315, SYN-257).
describe("v2 hosted builds share one lines baseline", () => {
  const charged = () => events("analyze").map((e) => e.body?.lines_count);

  it("charges nothing for lines an older `synapse analyze` already reported", async () => {
    fs.writeFileSync(prevPath(), JSON.stringify({ total_lines_analyzed: 1000 }));

    await runBuildV2({ custom: true, query: "orders" });
    await runBuildV2({ auto: true });

    expect(charged()).toEqual([]);
    expect(flows.runCustomFlow).toHaveBeenCalledTimes(1);
    expect(flows.runAutoFlow).toHaveBeenCalledTimes(1);
  });

  it("custom then auto on unchanged code charges the second build nothing", async () => {
    await runBuildV2({ custom: true, query: "orders" });
    expect(charged()).toEqual([1000]);
    fetchMock.mockClear();

    await runBuildV2({ auto: true });

    expect(charged()).toEqual([]);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1000));
  });

  it("charges growth once", async () => {
    fs.writeFileSync(prevPath(), JSON.stringify({ total_lines_analyzed: 1000 }));
    writeRepo(cwd, 1300);

    await runBuildV2({ auto: true });
    await runBuildV2({ custom: true, query: "orders" });

    expect(charged()).toEqual([300]);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1300));
  });

  it("migrates a file with both old keys to their max, without re-charging", async () => {
    fs.writeFileSync(
      prevPath(),
      JSON.stringify({ total_lines_analyzed: 1000, v2_lines_indexed: 998 }),
    );

    await runBuildV2({ auto: true });

    expect(charged()).toEqual([]);
    writeRepo(cwd, 1050);
    await runBuildV2({ auto: true });
    expect(charged()).toEqual([50]);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1050));
  });
});

describe("v2 hosted build with SYNAPSE_TELEMETRY=0", () => {
  beforeEach(() => {
    process.env.SYNAPSE_TELEMETRY = "0";
  });

  it("still runs the quota check and blocks a user who is over quota", async () => {
    server.quota = { status: 200, body: { quota_exceeded: true, quota_message: QUOTA_MSG } };

    await runBuildV2({ auto: true });

    expect(quotaCalls()).toHaveLength(1);
    expect(output).toContain(QUOTA_MSG);
    expect(flows.runAutoFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("still blocks on a 429 from the line-count event", async () => {
    server.analyze.push({ status: 429, body: { detail: QUOTA_MSG } });

    await runBuildV2({ auto: true });

    expect(output).toContain(QUOTA_MSG);
    expect(flows.runAutoFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sends only the minimal line-count record and no analytics", async () => {
    await runBuildV2({ auto: true });

    const analyze = events("analyze");
    expect(analyze).toHaveLength(1);
    expect(analyze[0].body).toEqual({ event_type: "analyze", lines_count: 1000, mode: "hosted" });
    expect(events("build")).toHaveLength(0);
  });
});

describe("v2 local build", () => {
  it("makes no quota check and sends no line count", async () => {
    await runBuildV2({ auto: true, local: true });

    expect(flows.runLocalAutoFlow).toHaveBeenCalledTimes(1);
    expect(quotaCalls()).toHaveLength(0);
    expect(events("analyze")).toHaveLength(0);
    expect(prevFile()).toBeNull();
  });
});
