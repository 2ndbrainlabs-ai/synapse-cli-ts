// `synapse build` reuses the last discovery result unless --discover is
// passed (SYN-8), and keeps the SYN-315 lines accounting correct.
//
// Same harness as build-v2-quota.test.ts: the real v2 extractor runs over a
// temp repo, and only the network (`fetch`) and the code-generation flows are
// stubbed. The extractor entry point is wrapped in a spy so the tests can tell
// a reused discovery (no scan) from a real one.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-v2-cache-home-"));
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
  runAutoFlow: vi.fn(async (_opts: unknown) => {}),
  runLocalAutoFlow: vi.fn(async (_opts: unknown) => {}),
  runCustomFlow: vi.fn(async (_opts: unknown) => {}),
}));
vi.mock("../../../src/commands/v2/auto-flow.js", () => ({ runAutoFlow: flows.runAutoFlow }));
vi.mock("../../../src/commands/v2/local-auto-flow.js", () => ({
  runLocalAutoFlow: flows.runLocalAutoFlow,
}));
vi.mock("../../../src/commands/v2/custom-flow.js", () => ({ runCustomFlow: flows.runCustomFlow }));

const extractor = vi.hoisted(() => ({ spy: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock("../../../src/extractors/core/extractor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/extractors/core/extractor.js")>();
  extractor.spy = vi.fn(actual.extractSurfaceStreamed);
  return { ...actual, extractSurfaceStreamed: extractor.spy };
});

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
const { SessionManager } = await import("../../../src/session/session-manager.js");
const { findResumable } = await import("../../../src/session/ledger.js");
const { computeRepoHash, newSessionId } = await import("../../../src/session/session-id.js");

const API = "https://api.example.test";
const FAKE_KEY = "syn_live_test_00000000000000000000";

type Reply = { status: number; body?: unknown };

let analyzeReplies: Reply[];
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

function bodies(): Array<{ url: string; body: Record<string, unknown> | null }> {
  return fetchMock.mock.calls.map(([url, init]) => {
    const i = (init ?? {}) as RequestInit;
    return { url: String(url), body: i.body ? (JSON.parse(String(i.body)) as Record<string, unknown>) : null };
  });
}
const quotaCalls = () => bodies().filter((c) => c.url === `${API}/quota`);
const charged = () =>
  bodies()
    .filter((c) => c.url === `${API}/telemetry/cli` && c.body?.event_type === "analyze")
    .map((c) => c.body?.lines_count);

const cachePath = () => path.join(cwd, ".synapse", "surface_cache.json");
const readCache = () => JSON.parse(fs.readFileSync(cachePath(), "utf-8"));

type Manifest = { endpoints: Array<{ path: string }>; functions: unknown[]; framework: string | null };
function lastManifest(fn: ReturnType<typeof vi.fn>): Manifest {
  const calls = fn.mock.calls;
  return (calls[calls.length - 1][0] as { manifest: Manifest }).manifest;
}
const paths = (m: Manifest) => m.endpoints.map((e) => e.path).sort();

/** FastAPI app: main.py with one route + a 10-line filler, so 20 lines. */
function writeRepo(dir: string, routes = ["/orders/{order_id}"]): void {
  const lines = ["from fastapi import FastAPI", "", "app = FastAPI()", ""];
  routes.forEach((r, i) => {
    lines.push(`@app.get("${r}")`, `def handler_${i}(order_id: str = ""):`, '    """Doc."""', "    return {}", "");
  });
  fs.writeFileSync(path.join(dir, "main.py"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\n");
}

function writeExtraFile(dir: string, name: string, route: string): void {
  fs.writeFileSync(
    path.join(dir, name),
    ["from fastapi import APIRouter", "", "router = APIRouter()", "", `@router.get("${route}")`, "def extra():", "    return {}", ""].join("\n"),
  );
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-v2-cache-"));
  writeRepo(cwd);
  fs.mkdirSync(path.join(cwd, ".synapse"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".synapse", "config.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);

  process.env.SYNAPSE_API_URL = API;
  process.env.SYNAPSE_API_KEY = FAKE_KEY;
  process.env.SYNAPSE_DISABLE_WORKERS = "1";
  delete process.env.SYNAPSE_TELEMETRY;
  process.exitCode = undefined;

  analyzeReplies = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${API}/quota`) return reply({ status: 200, body: { quota_exceeded: false } });
    const body = JSON.parse(String(init?.body ?? "{}")) as { event_type?: string };
    if (body.event_type === "analyze") return reply(analyzeReplies.shift() ?? { status: 200 });
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
  extractor.spy.mockClear();
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

/** Run a build and reset the per-run observations. */
async function build(opts: Parameters<typeof runBuildV2>[0]): Promise<void> {
  fetchMock.mockClear();
  extractor.spy.mockClear();
  output = "";
  await runBuildV2(opts);
}

describe("discovery cache (SYN-8), hosted", () => {
  it("first build discovers and saves the cache", async () => {
    expect(fs.existsSync(cachePath())).toBe(false);

    await build({ auto: true });

    expect(extractor.spy).toHaveBeenCalledTimes(1);
    const cache = readCache();
    expect(cache.version).toBe(1);
    expect(Object.keys(cache.files)).toEqual(["main.py"]);
    expect(cache.lines_scanned).toBe(9);
    expect(charged()).toEqual([9]);
    expect(output).not.toContain("Using the endpoints discovered on");
    expect(process.exitCode).toBeUndefined();
  });

  it("a later build reuses the cache without scanning and prints the hint", async () => {
    await build({ auto: true });
    await build({ auto: true });

    expect(extractor.spy).not.toHaveBeenCalled();
    expect(output).toContain("Using the endpoints discovered on");
    expect(output).toContain("synapse build --discover");
    expect(paths(lastManifest(flows.runAutoFlow))).toEqual(["/orders/{order_id}"]);
    expect(lastManifest(flows.runAutoFlow).framework).toBe("fastapi");
    expect(process.exitCode).toBeUndefined();
  });

  it("reuse still runs the hosted quota pre-check and sends no lines event", async () => {
    await build({ auto: true });
    await build({ auto: true });

    expect(quotaCalls()).toHaveLength(1);
    expect(charged()).toEqual([]);
  });

  it("reuse blocks the build when the pre-check says the quota is used up", async () => {
    await build({ auto: true });
    fetchMock.mockImplementation(async (url: string) =>
      url === `${API}/quota`
        ? reply({ status: 200, body: { quota_exceeded: true, quota_message: "over" } })
        : reply({ status: 200 }),
    );

    await build({ auto: true });

    expect(output).toContain("Quota Exceeded");
    expect(flows.runAutoFlow).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("reuse resends lines that were never accepted, so it can't skip a quota block", async () => {
    analyzeReplies.push({ status: 429, body: { detail: "Lines quota exceeded" } });
    await build({ auto: true });
    expect(process.exitCode).toBe(1);
    expect(flows.runAutoFlow).not.toHaveBeenCalled();
    process.exitCode = undefined;

    analyzeReplies.push({ status: 429, body: { detail: "Lines quota exceeded" } });
    await build({ auto: true });

    expect(extractor.spy).not.toHaveBeenCalled();
    expect(charged()).toEqual([9]);
    expect(flows.runAutoFlow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("reuse does not see code changes; --discover rescans and charges only the delta", async () => {
    await build({ auto: true });
    writeExtraFile(cwd, "extra.py", "/extra");

    await build({ auto: true });
    expect(paths(lastManifest(flows.runAutoFlow))).toEqual(["/orders/{order_id}"]);
    expect(charged()).toEqual([]);

    await build({ auto: true, discover: true });
    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(output).not.toContain("Using the endpoints discovered on");
    expect(paths(lastManifest(flows.runAutoFlow))).toEqual(["/extra", "/orders/{order_id}"]);
    expect(charged()).toEqual([7]);
    expect(Object.keys(readCache().files).sort()).toEqual(["extra.py", "main.py"]);
    // Unchanged files are replayed from the cache: the framework survives
    // and lines_scanned is the repo total, not just the re-parsed file.
    expect(lastManifest(flows.runAutoFlow).framework).toBe("fastapi");
    expect(readCache().lines_scanned).toBe(16);
  });

  it("--discover with no changes sends nothing and keeps the same result", async () => {
    await build({ auto: true });
    const before = readCache();

    await build({ auto: true, discover: true });

    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(charged()).toEqual([]);
    const after = readCache();
    expect(after.files).toEqual(before.files);
    expect(after.lines_scanned).toBe(before.lines_scanned);
    expect(after.framework).toBe("fastapi");
  });

  it("--discover drops endpoints from deleted files", async () => {
    writeExtraFile(cwd, "extra.py", "/extra");
    await build({ auto: true });
    fs.rmSync(path.join(cwd, "extra.py"));

    await build({ auto: true, discover: true });

    expect(paths(lastManifest(flows.runAutoFlow))).toEqual(["/orders/{order_id}"]);
    expect(Object.keys(readCache().files)).toEqual(["main.py"]);
  });

  it("a corrupt cache falls back to discovery and is rewritten", async () => {
    await build({ auto: true });
    fs.writeFileSync(cachePath(), "{not json");

    await build({ auto: true });

    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(flows.runAutoFlow).toHaveBeenCalledTimes(2);
    expect(readCache().version).toBe(1);
    expect(charged()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("a cache with no endpoints is not reused", async () => {
    fs.writeFileSync(path.join(cwd, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
    await build({ auto: true });
    writeRepo(cwd);

    await build({ auto: true });

    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(paths(lastManifest(flows.runAutoFlow))).toEqual(["/orders/{order_id}"]);
  });

  it("keeps the cache across git commits (it is not keyed on HEAD)", async () => {
    const git = (cmd: string) =>
      execSync(`git -c user.name=t -c user.email=t@example.test ${cmd}`, { cwd, stdio: "ignore" });
    git("init -q");
    git("add main.py requirements.txt");
    git("commit -q -m one");
    await build({ auto: true });
    writeExtraFile(cwd, "extra.py", "/extra");
    git("add extra.py");
    git("commit -q -m two");

    await build({ auto: true });

    expect(extractor.spy).not.toHaveBeenCalled();
    expect(output).toContain("Using the endpoints discovered on");
  });

  it("reused builds leave no resumable sessions behind", async () => {
    await build({ auto: true });
    await build({ auto: true });
    await build({ auto: true });

    expect(findResumable(cwd, computeRepoHash(cwd))).toEqual([]);
    expect(output).not.toContain("resumable session");
  });
});

describe("discovery cache (SYN-8), modes and --resume", () => {
  it("Custom rescans when the cache came from Auto, then reuses its own", async () => {
    fs.writeFileSync(
      path.join(cwd, "services.py"),
      ["def compute_total(items: list) -> int:", '    """Sum the order line items."""', "    return sum(items)", ""].join("\n"),
    );
    await build({ auto: true });

    await build({ custom: true, query: "orders" });
    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(output).toContain("doesn't include function data");
    expect(readCache().captured_functions).toBe(true);

    await build({ custom: true, query: "orders" });
    expect(extractor.spy).not.toHaveBeenCalled();
    expect(lastManifest(flows.runCustomFlow).functions.length).toBeGreaterThan(0);

    // Auto can reuse a Custom cache; it just doesn't get the functions.
    await build({ auto: true });
    expect(extractor.spy).not.toHaveBeenCalled();
    expect(lastManifest(flows.runAutoFlow).functions).toEqual([]);
  });

  it("--resume takes precedence over the cache and refreshes it", async () => {
    await build({ auto: true });
    const firstWrite = readCache().updated_at;
    // An unfinished session for this repo (e.g. a scan paused by Ctrl-C).
    const repoHash = computeRepoHash(cwd);
    const paused = new SessionManager({
      workingDir: cwd,
      sessionId: newSessionId(repoHash),
      mode: "auto",
      repoHash,
      cliVersion: "test",
    });
    paused.pause("sigint");
    paused.dispose();
    await new Promise((r) => setTimeout(r, 5));

    await build({ auto: true, resume: true });

    expect(output).toContain("Resuming");
    expect(output).not.toContain("Using the endpoints discovered on");
    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(readCache().updated_at).toBeGreaterThan(firstWrite);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("discovery cache (SYN-8), --local", () => {
  it("first build discovers, later builds reuse; no quota check or lines event", async () => {
    await build({ auto: true, local: true });
    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(cachePath())).toBe(true);

    await build({ auto: true, local: true });
    expect(extractor.spy).not.toHaveBeenCalled();
    expect(output).toContain("Using the endpoints discovered on");
    expect(flows.runLocalAutoFlow).toHaveBeenCalledTimes(2);
    expect(quotaCalls()).toHaveLength(0);
    expect(charged()).toEqual([]);

    await build({ auto: true, local: true, discover: true });
    expect(extractor.spy).toHaveBeenCalledTimes(1);
  });
});

describe("discovery cache (SYN-8), other languages", () => {
  it("a TypeScript --discover rescan with no changes keeps lines_scanned and sends nothing", async () => {
    fs.rmSync(path.join(cwd, "main.py"));
    fs.rmSync(path.join(cwd, "requirements.txt"));
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}\n");
    fs.writeFileSync(
      path.join(cwd, "server.ts"),
      ['import express from "express";', "const app = express();", 'app.get("/health", (req, res) => res.send("ok"));', ""].join("\n"),
    );

    await build({ auto: true });
    expect(paths(lastManifest(flows.runAutoFlow))).toEqual(["/health"]);
    const first = readCache();
    expect(first.lines_scanned).toBe(3);
    expect(charged()).toEqual([3]);

    await build({ auto: true, discover: true });

    expect(extractor.spy).toHaveBeenCalledTimes(1);
    expect(readCache().lines_scanned).toBe(3);
    expect(charged()).toEqual([]);
  });
});
