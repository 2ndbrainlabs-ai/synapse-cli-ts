// Shared lines-delta bookkeeping (SYN-315): one high-water baseline per repo
// in statistics.prev.json, raised only when the server accepts the delta.

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

const prevJson = () =>
  JSON.parse(fs.readFileSync(path.join(dir, PREV_STATS_FILE), "utf-8")) as Record<string, unknown>;
const writePrevJson = (data: unknown) =>
  fs.writeFileSync(path.join(dir, PREV_STATS_FILE), JSON.stringify(data));

describe("reportIndexedLines", () => {
  it("treats a missing file as 0", () => {
    expect(readPrevLines(dir)).toBe(0);
  });

  it("tolerates a corrupt file", async () => {
    fs.writeFileSync(path.join(dir, PREV_STATS_FILE), "not json");
    expect(await reportIndexedLines(base(10))).toEqual({ kind: "sent", delta: 10 });
    expect(readPrevLines(dir)).toBe(10);
  });

  it("sends nothing when the total has not grown", async () => {
    writePrevLines(dir, 500);
    expect(await reportIndexedLines(base(500))).toEqual({ kind: "unchanged" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only the growth, once", async () => {
    writePrevLines(dir, 500);
    expect(await reportIndexedLines(base(620))).toEqual({ kind: "sent", delta: 120 });
    expect(await reportIndexedLines(base(620))).toEqual({ kind: "unchanged" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not move the baseline after a failed send", async () => {
    writePrevLines(dir, 100);
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await reportIndexedLines(base(300))).toEqual({ kind: "failed", delta: 200, status: 503 });
    expect(readPrevLines(dir)).toBe(100);
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
    writePrevLines(dir, 1000);
    expect(await reportIndexedLines(base(600))).toEqual({ kind: "unchanged" });
    expect(readPrevLines(dir)).toBe(1000);
    expect(await reportIndexedLines(base(1000))).toEqual({ kind: "unchanged" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes the shared key and keeps the legacy keys and other fields in step", async () => {
    writePrevJson({ other: "x" });
    await reportIndexedLines(base(250));
    expect(prevJson()).toEqual({
      other: "x",
      lines_indexed: 250,
      total_lines_analyzed: 250,
      v2_lines_indexed: 250,
    });
  });
});

describe("migration from per-command baselines", () => {
  it("reads a legacy analyze-only file", () => {
    writePrevJson({ total_lines_analyzed: 42 });
    expect(readPrevLines(dir)).toBe(42);
  });

  it("reads a legacy build-only file", () => {
    writePrevJson({ v2_lines_indexed: 42 });
    expect(readPrevLines(dir)).toBe(42);
  });

  it("uses the larger of the two legacy keys", async () => {
    writePrevJson({ total_lines_analyzed: 115, v2_lines_indexed: 113 });
    expect(readPrevLines(dir)).toBe(115);
    expect(await reportIndexedLines(base(113))).toEqual({ kind: "unchanged" });
    expect(await reportIndexedLines(base(115))).toEqual({ kind: "unchanged" });
    expect(await reportIndexedLines(base(140))).toEqual({ kind: "sent", delta: 25 });
    expect(prevJson()).toEqual({
      lines_indexed: 140,
      total_lines_analyzed: 140,
      v2_lines_indexed: 140,
    });
  });

  it("ignores bad values in any key", () => {
    writePrevJson({ lines_indexed: "9", total_lines_analyzed: -5, v2_lines_indexed: null });
    expect(readPrevLines(dir)).toBe(0);
  });
});
