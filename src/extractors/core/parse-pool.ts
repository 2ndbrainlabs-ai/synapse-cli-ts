// src/extractors/core/parse-pool.ts
//
// Bounded pool of parse workers.  One worker per CPU (bounded by an env
// override), one tree-sitter Parser per worker, round-robin dispatch with a
// per-worker in-flight cap.
//
// Falls back to inline parsing when workers can't be started (e.g. bundled
// dist path missing).  That keeps `synapse build` correct even in unusual
// packaging setups — just slower.
//
// Lifecycle:
//   const pool = new ParsePool();
//   const out = await pool.parsePython({ source, relPath, module });
//   ...
//   await pool.dispose();

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  parsePythonFile,
  type PythonParseInput,
  type PythonParseOutput,
} from "../languages/python-parse.js";

interface Pending {
  resolve: (v: PythonParseOutput) => void;
  reject: (e: Error) => void;
}

interface WorkerEntry {
  w: Worker;
  inflight: number;
}

const DEFAULT_MAX_INFLIGHT_PER_WORKER = 2;

function resolveWorkerScript(): string | null {
  // Only the compiled JS worker is loadable via node:worker_threads without
  // a loader hook, so we require a real .js on disk. In dev (tsx running
  // .ts source), we fall back to inline parsing — correctness stays intact.
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    path.resolve(path.dirname(here), "../../../dist/parse-worker.js"),
    path.resolve(path.dirname(here), "parse-worker.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function poolSize(): number {
  const env = parseInt(process.env.SYNAPSE_PARSE_WORKERS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  const n = cpus().length;
  // Reserve one core for the main thread + I/O; cap at 8 to keep RSS sane.
  return Math.max(1, Math.min(8, n - 1));
}

export class ParsePool {
  private workers: WorkerEntry[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private cursor = 0;
  private disposed = false;
  private fallback = false;

  constructor() {
    if (process.env.SYNAPSE_DISABLE_WORKERS === "1") {
      this.fallback = true;
      return;
    }
    const workerScript = resolveWorkerScript();
    if (!workerScript) {
      this.fallback = true;
      return;
    }
    const size = poolSize();
    for (let i = 0; i < size; i++) {
      try {
        this.workers.push(this.spawn(workerScript));
      } catch {
        // If even one worker fails, gracefully degrade to inline.
        this.fallback = this.workers.length === 0;
      }
    }
    if (this.workers.length === 0) this.fallback = true;
  }

  private spawn(scriptPath: string): WorkerEntry {
    const w = new Worker(scriptPath);
    const entry: WorkerEntry = { w, inflight: 0 };
    w.on("message", (msg: any) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      entry.inflight = Math.max(0, entry.inflight - 1);
      if (msg.ok) p.resolve(msg.result as PythonParseOutput);
      else p.reject(new Error(msg.error ?? "worker error"));
    });
    w.on("error", (err) => {
      // Fail every in-flight pending on this worker's id space that we can't
      // trace back; simplest safe move is to fail all pending — the main
      // loop will still return a manifest with a `filesFailed` bump.
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(err);
      }
      entry.inflight = 0;
    });
    return entry;
  }

  private pick(): WorkerEntry | null {
    if (this.workers.length === 0) return null;
    // Prefer the least-busy worker; tie-break by round-robin.
    let best = this.workers[0];
    for (const w of this.workers) {
      if (w.inflight < best.inflight) best = w;
    }
    if (best.inflight >= DEFAULT_MAX_INFLIGHT_PER_WORKER) {
      // All workers saturated: pick round-robin so we still make progress.
      best = this.workers[this.cursor % this.workers.length];
      this.cursor++;
    }
    return best;
  }

  async parsePython(input: PythonParseInput): Promise<PythonParseOutput> {
    if (this.fallback || this.disposed) {
      return parsePythonFile(input);
    }
    const entry = this.pick();
    if (!entry) return parsePythonFile(input);
    const id = this.nextId++;
    entry.inflight++;
    return new Promise<PythonParseOutput>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      entry.w.postMessage({ id, kind: "parse_python", ...input });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Best-effort clean shutdown.
    await Promise.all(this.workers.map(async ({ w }) => {
      try {
        w.postMessage({ id: 0, kind: "shutdown" });
      } catch {
        /* ignore */
      }
      try {
        await w.terminate();
      } catch {
        /* ignore */
      }
    }));
    this.workers = [];
  }

  get info(): { workers: number; fallback: boolean } {
    return { workers: this.workers.length, fallback: this.fallback };
  }
}
