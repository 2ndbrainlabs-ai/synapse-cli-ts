// src/session/session-manager.ts
//
// SessionManager owns the AbortController + SIGINT handler + deadline for a
// discover run. It fronts the JSONL ledger and lets consumers (extractor,
// gRPC client, custom-flow) share a single abort signal so time-cap / Ctrl-C
// unwinds propagate cleanly.

import type { LedgerRecord, PauseReason, ResumeState } from "./ledger.js";
import { Ledger, buildResumeState, readLedger, sweepOldSessions } from "./ledger.js";

const DEFAULT_MAX_TIME_MS = 15 * 60 * 1000;

export interface SessionManagerOpts {
  workingDir: string;
  sessionId: string;
  mode: "auto" | "custom";
  repoHash: string;
  cliVersion: string;
  /** Soft-cap in ms; when reached the abort signal fires. Default 15 min. */
  maxTimeMs?: number;
  /** When resuming, we skip writing session_open so the timeline stays clean. */
  resumeFrom?: ResumeState;
}

export type ProgressPayload = {
  filesSeen: number;
  filesMatched: number;
  endpointsFound: number;
  functionsFound: number;
  elapsedMs: number;
};

export type ProgressListener = (p: ProgressPayload) => void;

export class SessionManager {
  readonly ledger: Ledger;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly resume: ResumeState;
  readonly workingDir: string;
  readonly repoHash: string;

  private readonly ac = new AbortController();
  private readonly sigintHandler: () => void;
  private readonly timerHandle: NodeJS.Timeout;
  private disposed = false;
  private paused = false;

  private progress: ProgressPayload = {
    filesSeen: 0,
    filesMatched: 0,
    endpointsFound: 0,
    functionsFound: 0,
    elapsedMs: 0,
  };
  private progressListeners: ProgressListener[] = [];

  constructor(opts: SessionManagerOpts) {
    this.ledger = new Ledger(opts.workingDir, opts.sessionId);
    this.workingDir = opts.workingDir;
    this.repoHash = opts.repoHash;
    this.startedAt = Date.now();
    this.deadlineAt = this.startedAt + (opts.maxTimeMs ?? DEFAULT_MAX_TIME_MS);
    this.resume = opts.resumeFrom ?? { meta: null, scanned: new Map(), skipped: new Map(), shards: [], completed: false };

    if (!opts.resumeFrom) {
      this.ledger.append({
        type: "session_open",
        session_id: opts.sessionId,
        mode: opts.mode,
        repo_hash: opts.repoHash,
        working_dir: opts.workingDir,
        cli_version: opts.cliVersion,
        started_at: this.startedAt,
        deadline_at: this.deadlineAt,
      });
    }

    // SIGINT — cleanest way to catch Ctrl-C across all platforms.
    this.sigintHandler = () => {
      if (this.disposed) return;
      this.pause("sigint", "Ctrl-C received");
    };
    process.on("SIGINT", this.sigintHandler);

    // Deadline: fire abort so consumers can drain.
    this.timerHandle = setTimeout(() => {
      if (this.disposed) return;
      this.pause("time_cap", "Reached configured --max-time cap");
    }, Math.max(1, this.deadlineAt - this.startedAt));
    // Don't hold the event loop open.
    this.timerHandle.unref?.();
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Sugar for consumers to check `if (session.aborted) break`. */
  get aborted(): boolean {
    return this.ac.signal.aborted;
  }

  append(record: LedgerRecord): void {
    this.ledger.append(record);
  }

  onProgress(listener: ProgressListener): void {
    this.progressListeners.push(listener);
  }

  bumpProgress(patch: Partial<ProgressPayload>): void {
    this.progress = { ...this.progress, ...patch, elapsedMs: this.elapsedMs };
    for (const l of this.progressListeners) {
      try {
        l(this.progress);
      } catch {
        /* listener errors must not crash the extractor */
      }
    }
  }

  /** Snapshot for callers who want a one-shot value. */
  snapshotProgress(): ProgressPayload {
    return { ...this.progress, elapsedMs: this.elapsedMs };
  }

  pause(reason: PauseReason, note?: string): void {
    if (this.paused) return;
    this.paused = true;
    try {
      this.ledger.append({
        type: "session_paused",
        reason,
        note,
        at: Date.now(),
      });
    } catch {
      /* the abort still happens even if ledger write fails */
    }
    this.ac.abort();
  }

  markDone(endpointsCount: number, functionsCount: number): void {
    if (this.disposed) return;
    this.ledger.append({
      type: "session_done",
      endpoints_count: endpointsCount,
      functions_count: functionsCount,
      at: Date.now(),
    });
    // Fire-and-forget sweep of stale sessions for this repo. Never throws;
    // best-effort so an unrelated permission issue doesn't crash the build.
    try {
      sweepOldSessions(this.workingDir, this.repoHash);
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      process.off("SIGINT", this.sigintHandler);
    } catch {
      /* ignore */
    }
    clearTimeout(this.timerHandle);
  }
}

/** Convenience for tests + external callers that don't want the class handle. */
export function loadResumeState(workingDir: string, sessionId: string): ResumeState {
  return buildResumeState(readLedger(workingDir, sessionId));
}
