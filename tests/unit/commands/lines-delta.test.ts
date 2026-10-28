// Shared lines-delta bookkeeping (SYN-315): the baseline in
// statistics.prev.json moves only when the server accepts the delta.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPrevLines,
  reportIndexedLines,
  writePrevLines,
  PREV_STATS_FILE,
} from "../../../src/commands/shared/lines-delta.js";
import { countLines } from "../../../src/utils/lines.js";

const FAKE_KEY = "syn_live_test_00000000000000000000";
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
const savedApi = process.env.SYNAPSE_API_URL;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-lines-delta-"));
  process.env.SYNAPSE_API_URL = "https://api.example.test";
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedApi === undefined) delete process.env.SYNAPSE_API_URL;
  else process.env.SYNAPSE_API_URL = savedApi;
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = (totalLines: number, extra: Partial<Parameters<typeof reportIndexedLines>[0]> = {}) => ({
  apiKey: FAKE_KEY,
  workingDir: "/tmp/project",
  synapseDir: dir,
  totalLines,
  key: "v2_lines_indexed" as const,
  ...extra,
});

describe("countLines", () => {
  it("counts lines like wc -l, plus an unterminated last line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\r\nb\r\n")).toBe(2);
    expect(countLines("\n\n")).toBe(2);
  });
});

describe("reportIndexedLines", () => {
  it("reads a legacy v1 file and treats a missing file as 0", () => {
    expect(readPrevLines(dir, "total_lines_analyzed")).toBe(0);
    fs.writeFileSync(path.join(dir, PREV_STATS_FILE), '{"total_lines_analyzed":42}');
    expect(readPrevLines(dir, "total_lines_analyzed")).toBe(42);
    expect(readPrevLines(dir, "v2_lines_indexed")).toBe(0);
  });

  it("tolerates a corrupt file", async () => {
    fs.writeFileSync(path.join(dir, PREV_STATS_FILE), "not json");
    expect(await reportIndexedLines(base(10))).toEqual({ kind: "sent", delta: 10 });
    expect(readPrevLines(dir, "v2_lines_indexed")).toBe(10);
  });

  it("sends nothing when the total has not grown", async () => {
    writePrevLines(dir, "v2_lines_indexed", 500);
    expect(await reportIndexedLines(base(500))).toEqual({ kind: "unchanged" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not move the baseline after a failed send", async () => {
    writePrevLines(dir, "v2_lines_indexed", 100);
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await reportIndexedLines(base(300))).toEqual({ kind: "failed", delta: 200, status: 503 });
    expect(readPrevLines(dir, "v2_lines_indexed")).toBe(100);
  });

  it("does not send or record anything without an API key", async () => {
    expect(await reportIndexedLines(base(300, { apiKey: "" }))).toEqual({
      kind: "skipped",
      delta: 300,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, PREV_STATS_FILE))).toBe(false);
  });

  it("keeps a high-water baseline so a smaller scan never re-charges", async () => {
    writePrevLines(dir, "v2_lines_indexed", 1000);
    expect(await reportIndexedLines(base(600, { highWater: true }))).toEqual({ kind: "unchanged" });
    expect(readPrevLines(dir, "v2_lines_indexed")).toBe(1000);
    expect(await reportIndexedLines(base(1000, { highWater: true }))).toEqual({ kind: "unchanged" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lowers the baseline without high-water (v1 analyze behaviour)", async () => {
    writePrevLines(dir, "total_lines_analyzed", 1000);
    await reportIndexedLines(base(600, { key: "total_lines_analyzed" }));
    expect(readPrevLines(dir, "total_lines_analyzed")).toBe(600);
  });
});
