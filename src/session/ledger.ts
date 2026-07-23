// src/session/ledger.ts
//
// Append-only JSONL session ledger. Matches Claude Code's on-disk pattern:
// one file per session, one JSON object per line, resume works by replay.
//
// Zero native dependencies. `fs.appendFileSync` is atomic on POSIX for the
// line lengths we write (< 4 KB) — we cap each record at ~3 KB by
// truncating docstrings before writing.

import fs from "node:fs";
import path from "node:path";
import { getProjectSynapseDir } from "../config/paths.js";
import type { HttpEndpoint, SurfaceFunction } from "../extractors/core/surface-manifest.js";

// -----------------------------------------------------------------------------
// Record types
// -----------------------------------------------------------------------------

export type PauseReason = "time_cap" | "sigint" | "network" | "error";
export type SkipReason = "unchanged" | "oversized" | "no_marker";
export type BuildMode = "auto" | "custom";

export interface FunctionVerdict {
  qualname: string;
  band: "HIGH" | "MEDIUM" | "LOW" | "SKIP";
  tool_shape?: string;
  workflow_hints?: string[];
  one_line_purpose?: string;
}

export type LedgerRecord =
  | {
      type: "session_open";
      session_id: string;
      mode: BuildMode;
      repo_hash: string;
      working_dir: string;
      cli_version: string;
      started_at: number;
      deadline_at: number;
    }
  | {
      type: "file_scanned";
      path: string;
      sha: string;
      endpoints: HttpEndpoint[];
      functions: SurfaceFunction[];
      scanned_at: number;
      elapsed_ms: number;
    }
  | {
      type: "file_skipped";
      path: string;
      reason: SkipReason;
      at: number;
    }
  | {
      type: "shard_classified";
      shard_id: number;
      verdicts: FunctionVerdict[];
      at: number;
    }
  | {
      type: "workflow_proposal";
      name: string;
      purpose: string;
      functions: string[];
      confidence: number;
      at: number;
    }
  | {
      type: "session_paused";
      reason: PauseReason;
      cursor?: string;
      note?: string;
      at: number;
    }
  | {
      type: "session_done";
      endpoints_count: number;
      functions_count: number;
      at: number;
    };

// -----------------------------------------------------------------------------
// Ledger — one instance per session, opened lazily on first append.
// -----------------------------------------------------------------------------

const MAX_RECORD_BYTES = 3072; // conservative cap; POSIX guarantees atomic append below PIPE_BUF (4096)

function getDiscoverDir(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "discover");
}

export function getLedgerPath(workingDir: string, sessionId: string): string {
  return path.join(getDiscoverDir(workingDir), `${sessionId}.jsonl`);
}

/** Truncate any strings in the payload down to fit MAX_RECORD_BYTES. Focuses
 *  on the fields we know can blow the budget: docstrings, signatures. */
function shrinkRecord(rec: LedgerRecord): LedgerRecord {
  if (rec.type !== "file_scanned") return rec;
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  return {
    ...rec,
    endpoints: rec.endpoints.map((e) => ({
      ...e,
      description: clip(e.description ?? "", 240),
    })),
    functions: rec.functions.map((f) => ({
      ...f,
      docstring: clip(f.docstring ?? "", 240),
      signature: clip(f.signature ?? "", 240),
    })),
  };
}

export class Ledger {
  private readonly filePath: string;
  private opened = false;

  constructor(readonly workingDir: string, readonly sessionId: string) {
    this.filePath = getLedgerPath(workingDir, sessionId);
  }

  private ensureDir(): void {
    if (this.opened) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.opened = true;
  }

  append(record: LedgerRecord): void {
    this.ensureDir();
    const shrunk = shrinkRecord(record);
    let line = JSON.stringify(shrunk);
    if (line.length + 1 > MAX_RECORD_BYTES) {
      // Last-resort truncation: keep type + timestamp + minimal identity.
      const at = (record as { at?: number; scanned_at?: number }).at
        ?? (record as { scanned_at?: number }).scanned_at
        ?? Date.now();
      line = JSON.stringify({
        type: record.type,
        at,
        _truncated: true,
        note: `record exceeded ${MAX_RECORD_BYTES}B before appending`,
      });
    }
    fs.appendFileSync(this.filePath, line + "\n", { flag: "a" });
  }
}

// -----------------------------------------------------------------------------
// Read side — replay a ledger to build the resume cache.
// -----------------------------------------------------------------------------

export function readLedger(workingDir: string, sessionId: string): LedgerRecord[] {
  const filePath = getLedgerPath(workingDir, sessionId);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const out: LedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed lines — the append is atomic per record but a
      // partial power-cut mid-write could leave garbage. We just skip.
    }
  }
  return out;
}

export interface ResumeState {
  meta: Extract<LedgerRecord, { type: "session_open" }> | null;
  /** Path → last file_scanned record. Consulted before re-parsing. */
  scanned: Map<string, Extract<LedgerRecord, { type: "file_scanned" }>>;
  /** Set of paths already recorded as skipped (unchanged/oversized/no_marker). */
  skipped: Map<string, SkipReason>;
  /** Classifier shards that already completed — replay verdicts without recall. */
  shards: Extract<LedgerRecord, { type: "shard_classified" }>[];
  /** True if a session_done record was ever appended. */
  completed: boolean;
  /** Most recent paused record, if any. */
  paused?: Extract<LedgerRecord, { type: "session_paused" }>;
}

export function buildResumeState(records: LedgerRecord[]): ResumeState {
  const state: ResumeState = {
    meta: null,
    scanned: new Map(),
    skipped: new Map(),
    shards: [],
    completed: false,
  };
  for (const r of records) {
    switch (r.type) {
      case "session_open":
        state.meta = r;
        break;
      case "file_scanned":
        state.scanned.set(r.path, r);
        break;
      case "file_skipped":
        state.skipped.set(r.path, r.reason);
        break;
      case "shard_classified":
        state.shards.push(r);
        break;
      case "session_paused":
        state.paused = r;
        break;
      case "session_done":
        state.completed = true;
        break;
    }
  }
  return state;
}

// -----------------------------------------------------------------------------
// Session discovery — find resumable sessions for a given repo_hash.
// -----------------------------------------------------------------------------

export interface ResumableSession {
  sessionId: string;
  filePath: string;
  meta: Extract<LedgerRecord, { type: "session_open" }>;
  filesScanned: number;
  completed: boolean;
  pausedReason?: PauseReason;
  mtime: number;
}

// -----------------------------------------------------------------------------
// Retention — sweep completed/paused sessions older than N days.
// -----------------------------------------------------------------------------

export interface SweepStats {
  removed: number;
  bytesReclaimed: number;
}

/**
 * Delete session JSONL files older than `maxAgeMs` from `.synapse/discover/`
 * for this repo. By default we only sweep sessions for the *same* repo_hash,
 * so a monorepo running many builds doesn't lose sessions from unrelated
 * checkouts.
 *
 * Safe to call at any time; missing directory returns zeros.
 */
export function sweepOldSessions(
  workingDir: string,
  repoHash: string,
  maxAgeMs: number = 30 * 24 * 60 * 60 * 1000, // 30 days
): SweepStats {
  const dir = getDiscoverDir(workingDir);
  const stats: SweepStats = { removed: 0, bytesReclaimed: 0 };
  if (!fs.existsSync(dir)) return stats;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, entry);
    let mtime: number;
    let size: number;
    try {
      const st = fs.statSync(filePath);
      mtime = st.mtimeMs;
      size = st.size;
    } catch {
      continue;
    }
    if (mtime > cutoff) continue;
    // Filter by repo_hash: only sweep sessions whose session_open matches.
    const sessionId = entry.slice(0, -".jsonl".length);
    let records: LedgerRecord[];
    try {
      records = readLedger(workingDir, sessionId);
    } catch {
      continue;
    }
    const meta = records.find((r): r is Extract<LedgerRecord, { type: "session_open" }> => r.type === "session_open");
    if (!meta || meta.repo_hash !== repoHash) continue;
    try {
      fs.unlinkSync(filePath);
      stats.removed++;
      stats.bytesReclaimed += size;
    } catch {
      // Best-effort — a permission issue shouldn't crash the build.
    }
  }
  return stats;
}

export function findResumable(workingDir: string, repoHash: string): ResumableSession[] {
  const dir = getDiscoverDir(workingDir);
  if (!fs.existsSync(dir)) return [];
  const out: ResumableSession[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const sessionId = entry.slice(0, -".jsonl".length);
    const filePath = path.join(dir, entry);
    let records: LedgerRecord[];
    try {
      records = readLedger(workingDir, sessionId);
    } catch {
      continue;
    }
    const state = buildResumeState(records);
    if (!state.meta || state.meta.repo_hash !== repoHash) continue;
    if (state.completed) continue; // fully-done sessions are archival, not resumable
    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      /* ignore */
    }
    out.push({
      sessionId,
      filePath,
      meta: state.meta,
      filesScanned: state.scanned.size,
      completed: false,
      pausedReason: state.paused?.reason,
      mtime,
    });
  }
  // Most recent first.
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
