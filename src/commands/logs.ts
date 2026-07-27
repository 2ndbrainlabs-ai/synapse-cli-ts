// src/commands/logs.ts
//
// `synapse logs [session-id]` — human-friendly view over the discover ledger.
//
// Prints:
//   1. Session metadata (mode, repo hash, started at)
//   2. Every session_error record in the ledger — with code, stage, hint
//   3. Last progress snapshot (files scanned / matched / endpoints / functions)
//   4. Terminal status: done, paused, in-progress
//   5. Absolute path to the JSONL for `jq` / support forwarding
//
// Users can share the raw JSONL when reporting an issue — it never contains
// source bytes, only paths + SHA + counts.

import fs from "node:fs";
import path from "node:path";
import { getProjectSynapseDir } from "../config/paths.js";
import {
  findResumable,
  getLedgerPath,
  readLedger,
  buildResumeState,
  type LedgerRecord,
  type SessionErrorPayload,
} from "../session/ledger.js";
import { computeRepoHash } from "../session/session-id.js";
import { t, stepInfo, stepWarn } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";

export interface LogsOptions {
  sessionId?: string;
  /** When true, dump the raw ledger content instead of a pretty view. */
  raw?: boolean;
  /** List all known sessions for this repo. */
  list?: boolean;
}

function relTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function fmtCounts(records: LedgerRecord[]): {
  scanned: number;
  skipped: number;
  endpoints: number;
  functions: number;
} {
  let scanned = 0;
  let skipped = 0;
  let endpoints = 0;
  let functions = 0;
  for (const r of records) {
    if (r.type === "file_scanned") {
      scanned++;
      endpoints += r.endpoints.length;
      functions += r.functions.length;
    } else if (r.type === "file_skipped") {
      skipped++;
    }
  }
  return { scanned, skipped, endpoints, functions };
}

function terminalState(records: LedgerRecord[]): { label: string; color: (s: string) => string } {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === "session_done") return { label: "done", color: t.ok };
    if (r.type === "session_paused") return { label: `paused (${r.reason})`, color: t.warn };
    if (r.type === "session_error") return { label: "errored", color: t.err };
  }
  return { label: "in-progress", color: t.dim };
}

function pickSessionForWorkingDir(workingDir: string, sessionId?: string): string | null {
  if (sessionId) {
    const filePath = getLedgerPath(workingDir, sessionId);
    if (fs.existsSync(filePath)) return sessionId;
    stepWarn("Session not found", sessionId);
    return null;
  }
  // Fall back to the most recent session for the current repo (any state).
  const repoHash = computeRepoHash(workingDir);
  const list = findResumable(workingDir, repoHash);
  if (list.length > 0) return list[0].sessionId;
  // findResumable filters out `session_done` sessions; fall back to
  // whichever JSONL was most recently touched.
  const dir = path.join(getProjectSynapseDir(workingDir), "discover");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].f.slice(0, -".jsonl".length) : null;
}

function printErrorRecord(err: SessionErrorPayload & { at: number }): void {
  const lines: string[] = [];
  lines.push(`${t.err("[" + err.code + "]")}  ${t.text(err.message)}  ${t.dim("(" + relTime(err.at) + ")")}`);
  lines.push(`  ${t.dim("stage:")} ${err.stage}`);
  if (err.hint) lines.push(`  ${t.brand("hint:")}  ${err.hint}`);
  if (err.missing_fields && err.missing_fields.length > 0) {
    lines.push(`  ${t.dim("missing:")} ${err.missing_fields.slice(0, 5).join(", ")}${err.missing_fields.length > 5 ? " …" : ""}`);
  }
  if (err.technical) {
    const first = err.technical.split("\n").slice(0, 3);
    for (const line of first) lines.push(`  ${t.subtle(line)}`);
  }
  console.log(lines.join("\n"));
}

export async function runLogs(opts: LogsOptions): Promise<void> {
  const workingDir = process.cwd();

  // List mode: show every session known to this repo.
  if (opts.list) {
    const repoHash = computeRepoHash(workingDir);
    const dir = path.join(getProjectSynapseDir(workingDir), "discover");
    if (!fs.existsSync(dir)) {
      stepInfo("No sessions", "run `synapse build` to create one");
      return;
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) {
      stepInfo("No sessions", "run `synapse build` to create one");
      return;
    }
    console.log();
    console.log("  " + t.brandBold("Discover sessions for this repo:"));
    console.log();
    for (const f of files) {
      const sid = f.slice(0, -".jsonl".length);
      const records = readLedger(workingDir, sid);
      const meta = records.find((r): r is Extract<LedgerRecord, { type: "session_open" }> => r.type === "session_open");
      if (!meta || meta.repo_hash !== repoHash) continue;
      const term = terminalState(records);
      const counts = fmtCounts(records);
      console.log(
        `  ${t.subtle(sid)}  ${term.color(term.label)}  ${t.dim(`scanned ${counts.scanned}, ${counts.endpoints} ep, ${counts.functions} fn — ${relTime(meta.started_at)}`)}`,
      );
    }
    console.log();
    return;
  }

  const sessionId = pickSessionForWorkingDir(workingDir, opts.sessionId);
  if (!sessionId) {
    stepInfo("No sessions found", "run `synapse build` to create one");
    return;
  }

  const filePath = getLedgerPath(workingDir, sessionId);
  if (opts.raw) {
    // Straight passthrough for `synapse logs --raw | jq`.
    process.stdout.write(fs.readFileSync(filePath, "utf-8"));
    return;
  }

  const records = readLedger(workingDir, sessionId);
  const meta = records.find((r): r is Extract<LedgerRecord, { type: "session_open" }> => r.type === "session_open");
  const term = terminalState(records);
  const counts = fmtCounts(records);
  const errors = records.filter((r): r is Extract<LedgerRecord, { type: "session_error" }> => r.type === "session_error");

  const state = buildResumeState(records);

  const summary: string[] = [];
  summary.push(`${t.dim("Session:")}   ${t.subtle(sessionId)}`);
  if (meta) {
    summary.push(`${t.dim("Mode:")}      ${meta.mode}`);
    summary.push(`${t.dim("Started:")}   ${new Date(meta.started_at).toLocaleString()}  ${t.dim("(" + relTime(meta.started_at) + ")")}`);
  }
  summary.push(`${t.dim("Status:")}    ${term.color(term.label)}`);
  summary.push(`${t.dim("Scanned:")}   ${counts.scanned} files (${counts.skipped} skipped)`);
  summary.push(`${t.dim("Extracted:")} ${counts.endpoints} endpoints, ${counts.functions} functions`);
  if (state.paused) {
    summary.push(`${t.dim("Paused:")}    ${state.paused.reason}${state.paused.note ? " — " + state.paused.note : ""}`);
  }
  summary.push("");
  summary.push(`${t.dim("Logs file:")} ${t.subtle(filePath)}`);

  roundedBox("Session Log", "📄", t.brand, summary);

  if (errors.length > 0) {
    console.log();
    console.log(`  ${t.err("Errors (" + errors.length + "):")}`);
    console.log();
    for (const err of errors) printErrorRecord(err);
    console.log();
    console.log(`  ${t.dim("Quote the session id + logs file above when reporting an issue.")}`);
    console.log();
  }
}
