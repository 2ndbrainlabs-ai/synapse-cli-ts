// `synapse analyze` line-count reporting (SYN-315).
//
// The analyzer itself is stubbed to report a fixed total; `fetch` is stubbed
// so the test sees exactly what goes to /telemetry/cli and can check that
// statistics.prev.json only moves when the server accepted the lines.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-analyze-home-"));
const TMP_GLOBAL_DIR = path.join(TMP_HOME, ".synapse");

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  return {
    ...actual,
    GLOBAL_SYNAPSE_DIR: TMP_GLOBAL_DIR,
    GLOBAL_CONFIG_PATH: path.join(TMP_GLOBAL_DIR, "config.json"),
  };
});

const analyzer = vi.hoisted(() => ({ totalLines: 1000 }));
vi.mock("../../../src/analyzer/codebase-analyzer.js", () => ({
  analyzeCodebase: () => [
    "schema",
    {
      project_name: "p",
      directory_count: 1,
      file_count: 1,
      total_lines_analyzed: analyzer.totalLines,
      module_count: 1,
      class_count: 0,
      function_count: 1,
      method_count: 0,
      total_callable_count: 1,
    },
  ],
  saveAnalysisResults: () => {},
}));

const { runAnalyze } = await import("../../../src/commands/analyze.js");

const API = "https://api.example.test";
const FAKE_KEY = "syn_live_test_00000000000000000000";

let cwd: string;
let output: string;
let analyzeReplies: Array<{ status: number; detail?: string }>;
let fetchMock: ReturnType<typeof vi.fn>;
const saved = { ...process.env };

const prevPath = () => path.join(cwd, ".synapse", "statistics.prev.json");
const baseline = (n: number) => ({
  lines_indexed: n,
  total_lines_analyzed: n,
  v2_lines_indexed: n,
});
const prevFile = () => (fs.existsSync(prevPath()) ? fs.readFileSync(prevPath(), "utf-8") : null);
const analyzeEvents = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === `${API}/telemetry/cli`)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    .filter((b) => b.event_type === "analyze");

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-analyze-"));
  fs.mkdirSync(path.join(cwd, ".synapse"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".synapse", "config.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.SYNAPSE_API_URL = API;
  process.env.SYNAPSE_API_KEY = FAKE_KEY;
  delete process.env.SYNAPSE_TELEMETRY;
  analyzer.totalLines = 1000;
  analyzeReplies = [];

  fetchMock = vi.fn(async (url: string) => {
    if (url === `${API}/quota`) return new Response(JSON.stringify({ quota_exceeded: false }));
    const r = analyzeReplies.shift() ?? { status: 200 };
    return new Response(r.detail ? JSON.stringify({ detail: r.detail }) : null, {
      status: r.status,
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  output = "";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    output += a.map(String).join(" ") + "\n";
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(cwd, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("synapse analyze: lines reporting (SYN-315)", () => {
  it("sends the delta and records the baseline when the server accepts it", async () => {
    await runAnalyze(".synapse", false);

    expect(analyzeEvents().map((e) => e.lines_count)).toEqual([1000]);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1000));
  });

  it("leaves statistics.prev.json unchanged after a 500 and resends next run", async () => {
    fs.writeFileSync(prevPath(), JSON.stringify({ total_lines_analyzed: 400 }));
    const before = prevFile();
    analyzeReplies.push({ status: 500 });

    await runAnalyze(".synapse", false);

    expect(analyzeEvents().map((e) => e.lines_count)).toEqual([600]);
    expect(prevFile()).toBe(before);

    fetchMock.mockClear();
    await runAnalyze(".synapse", false);
    expect(analyzeEvents().map((e) => e.lines_count)).toEqual([600]);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1000));
  });

  it("shows the quota box on a 429 and keeps the baseline", async () => {
    analyzeReplies.push({ status: 429, detail: "Lines analyzed quota exceeded." });

    await runAnalyze(".synapse", false);

    expect(output).toContain("Quota Exceeded");
    expect(output).toContain("Lines analyzed quota exceeded.");
    expect(prevFile()).toBeNull();
  });

  it("charges nothing for lines a build already reported", async () => {
    fs.writeFileSync(prevPath(), JSON.stringify({ v2_lines_indexed: 1000 }));

    await runAnalyze(".synapse", false);

    expect(analyzeEvents()).toHaveLength(0);
  });

  it("charges only the lines above a build's baseline, then raises the shared one", async () => {
    fs.writeFileSync(prevPath(), JSON.stringify({ v2_lines_indexed: 900 }));

    await runAnalyze(".synapse", false);

    expect(analyzeEvents().map((e) => e.lines_count)).toEqual([100]);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1000));
  });

  it("never lowers the baseline when the analyzed total shrinks", async () => {
    fs.writeFileSync(prevPath(), JSON.stringify(baseline(1000)));
    analyzer.totalLines = 600;

    await runAnalyze(".synapse", false);
    analyzer.totalLines = 1000;
    await runAnalyze(".synapse", false);

    expect(analyzeEvents()).toHaveLength(0);
    expect(JSON.parse(prevFile()!)).toEqual(baseline(1000));
  });
});
