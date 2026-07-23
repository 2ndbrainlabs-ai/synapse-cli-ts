// src/extractors/languages/python-streamed.ts
//
// Streaming Python extractor for large repos.
//
// Consumes the Aho-Corasick prefilter (extractors/core/prefilter.ts) so
// tree-sitter only ever runs on files whose 64KB head matched a route or
// function needle. Every parsed file is checkpointed to the session ledger,
// making the flow fully resumable across Ctrl-C, 15-min deadline, and
// network drops.
//
// Parse work runs on a worker_threads pool (extractors/core/parse-pool.ts)
// so the CLI main thread stays responsive — the spinner keeps ticking,
// SIGINT arrives promptly, and a gRPC stream (if open) can still keepalive.
//
// Every scanned file's result is memoised by SHA-256 in the ledger: the
// second run over the same repo re-parses only files whose bytes changed.

import fs from "node:fs/promises";
import path from "node:path";

import type {
  HttpEndpoint,
  SurfaceFunction,
  SurfaceManifest,
} from "../core/surface-manifest.js";
import { detectPackageRoot } from "./python.js";
import { NEEDLE_TABLE } from "../core/needles.js";
import { sniffCandidateFiles } from "../core/prefilter.js";
import { ParsePool } from "../core/parse-pool.js";
import { pathToModule } from "./python-parse.js";
import type { SessionManager } from "../../session/session-manager.js";

// -----------------------------------------------------------------------------
// Local scoring for Custom mode (zero tokens)
// -----------------------------------------------------------------------------

const RANKED_DECORATOR_HINTS = /@(task|tool|job|command|action|route|entry|op)\b/i;

/** Deterministic, cheap function-shape score. Higher = better MCP tool candidate. */
export function scoreFunction(f: SurfaceFunction, callSiteCount = 0): number {
  let s = 0;
  if (f.docstring && f.docstring.length > 20) s += 3;
  if (f.signature.includes(":")) s += 2;                       // typed params
  if (/->\s*[\w\[\]]+/.test(f.signature)) s += 2;             // typed return
  if (RANKED_DECORATOR_HINTS.test(f.signature)) s += 3;
  s += Math.min(callSiteCount, 5);
  if (f.qualname.startsWith("_")) s -= 5;
  if (/\btests?\b/i.test(f.file_path)) s -= 5;
  if (f.qualname.length < 3) s -= 2;
  if (f.is_async) s += 1;
  return s;
}

// -----------------------------------------------------------------------------
// Public API — streaming extractor
// -----------------------------------------------------------------------------

export interface StreamedExtractOptions {
  workingDir: string;
  session: SessionManager;
  /** Include function candidates for Custom mode. Default true. */
  captureFunctions?: boolean;
  /** Max concurrent parses in flight. Defaults to workers × 2. */
  parseBatch?: number;
}

export interface StreamedManifest extends SurfaceManifest {
  /** True when the scan was interrupted (sigint / deadline / abort). */
  partial: boolean;
  stats: {
    filesSeen: number;
    filesMatched: number;
    filesParsed: number;
    filesSkippedUnchanged: number;
    filesFailed: number;
    wallMs: number;
    poolWorkers: number;
    poolFallback: boolean;
  };
}

interface ParseJobInput {
  source: string;
  relPath: string;
  sha: string;
}

export async function extractPythonSurfaceStreamed(
  opts: StreamedExtractOptions,
): Promise<StreamedManifest> {
  const workingDir = path.resolve(opts.workingDir);
  const session = opts.session;
  const captureFns = opts.captureFunctions !== false;

  const endpoints: HttpEndpoint[] = [];
  const functions: SurfaceFunction[] = [];
  const frameworkHits = new Map<string, number>();

  const scannedCache = session.resume.scanned;

  let filesParsed = 0;
  let filesFailed = 0;
  let filesSkippedUnchanged = 0;
  let sniffStats = { filesSeen: 0, filesMatched: 0, filesSkipped: 0 };
  const startTs = Date.now();

  // Boot the parse pool once for the whole scan.
  const pool = new ParsePool();
  const poolInfo = pool.info;
  const batchSize = Math.max(1, opts.parseBatch ?? Math.max(4, poolInfo.workers * 2));

  const py = NEEDLE_TABLE.python;
  const iterator = sniffCandidateFiles(
    {
      workingDir,
      needles: py.route,
      extraNeedles: captureFns ? py.callable : undefined,
      signal: session.signal,
    },
    (p) => {
      sniffStats = p;
      session.bumpProgress({
        filesSeen: p.filesSeen,
        filesMatched: p.filesMatched,
        endpointsFound: endpoints.length,
        functionsFound: functions.length,
      });
    },
  );

  // Drain the iterator, dispatch parse jobs in bounded batches so the pool
  // never sees more than `batchSize` in-flight tasks at once.
  let batch: ParseJobInput[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    const results = await Promise.all(current.map(async (job) => {
      try {
        const out = await pool.parsePython({
          source: job.source,
          relPath: job.relPath,
          module: pathToModule(job.relPath),
        });
        return { job, out };
      } catch {
        return { job, out: null };
      }
    }));
    for (const { job, out } of results) {
      if (!out || !out.parseOk) {
        filesFailed++;
        continue;
      }
      for (const fw of out.frameworkHits) {
        frameworkHits.set(fw, (frameworkHits.get(fw) ?? 0) + 1);
      }
      endpoints.push(...out.endpoints);
      if (captureFns) functions.push(...out.functions);
      filesParsed++;

      const scannedAt = Date.now();
      session.append({
        type: "file_scanned",
        path: job.relPath,
        sha: job.sha,
        endpoints: out.endpoints,
        functions: captureFns ? out.functions : [],
        scanned_at: scannedAt,
        elapsed_ms: scannedAt - startTs,
      });
    }
    session.bumpProgress({
      endpointsFound: endpoints.length,
      functionsFound: functions.length,
    });
  };

  try {
    for await (const hit of iterator) {
      if (session.aborted) break;

      const relPath = hit.relPath;

      // Content-hash cache hit — replay from ledger, no re-parse.
      const cached = scannedCache.get(relPath);
      if (cached && cached.sha === hit.sha) {
        endpoints.push(...cached.endpoints);
        if (captureFns) functions.push(...cached.functions);
        filesSkippedUnchanged++;
        session.bumpProgress({
          endpointsFound: endpoints.length,
          functionsFound: functions.length,
        });
        continue;
      }

      let source: string;
      try {
        source = hit.fullHashed
          ? hit.head.toString("utf-8")
          : await fs.readFile(hit.path, "utf-8");
      } catch {
        filesFailed++;
        session.append({
          type: "file_skipped",
          path: relPath,
          reason: "no_marker",
          at: Date.now(),
        });
        continue;
      }

      batch.push({ source, relPath, sha: hit.sha });
      if (batch.length >= batchSize) {
        await flush();
        if (session.aborted) break;
      }
    }
    // Final drain.
    if (!session.aborted) await flush();
  } finally {
    await pool.dispose();
  }

  // Framework by prevalence.
  let framework: string | null = null;
  let bestHit = 0;
  for (const [name, hits] of frameworkHits) {
    if (hits > bestHit) { framework = name; bestHit = hits; }
  }

  const partial = session.aborted;
  const packageRoot = detectPackageRoot(functions, endpoints);

  const manifest: StreamedManifest = {
    language: "python",
    framework,
    endpoints,
    functions,
    package_import_root: packageRoot,
    partial,
    stats: {
      filesSeen: sniffStats.filesSeen,
      filesMatched: sniffStats.filesMatched,
      filesParsed,
      filesSkippedUnchanged,
      filesFailed,
      wallMs: Date.now() - startTs,
      poolWorkers: poolInfo.workers,
      poolFallback: poolInfo.fallback,
    },
  };

  if (!partial) {
    session.markDone(endpoints.length, functions.length);
  }

  return manifest;
}

// -----------------------------------------------------------------------------
// Ranking helpers for Custom mode
// -----------------------------------------------------------------------------

export interface RankedFunction extends SurfaceFunction {
  score: number;
  call_site_count: number;
}

/** Cheap grep pass: for each candidate qualname, count occurrences in the
 *  scanned candidate files. This is a rough proxy for how often the function
 *  is referenced elsewhere, but it's zero-token and fast enough for the ranker. */
export async function computeCallSiteCounts(
  workingDir: string,
  functions: readonly SurfaceFunction[],
  signal?: AbortSignal,
  budgetMs = 5000,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (functions.length === 0) return counts;

  const startTs = Date.now();

  const files = new Set<string>();
  for (const f of functions) files.add(f.file_path);

  const workDir = path.resolve(workingDir);

  for (const rel of files) {
    if (signal?.aborted) break;
    if (Date.now() - startTs > budgetMs) break;
    let source: string;
    try {
      source = await fs.readFile(path.join(workDir, rel), "utf-8");
    } catch {
      continue;
    }
    for (const f of functions) {
      const pattern = new RegExp(String.raw`\b${escapeRe(f.qualname)}\s*\(`, "g");
      const hits = source.match(pattern);
      if (hits) {
        counts.set(f.qualname, (counts.get(f.qualname) ?? 0) + hits.length);
      }
    }
  }

  // Definition itself is one of the matches — subtract it.
  for (const f of functions) {
    if (counts.has(f.qualname)) {
      counts.set(f.qualname, Math.max(0, (counts.get(f.qualname) ?? 0) - 1));
    }
  }
  return counts;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sort candidates in-place by scoreFunction desc; return top-K + background sidecar. */
export function rankFunctionsInPlace(
  functions: SurfaceFunction[],
  callCounts: Map<string, number>,
  topK: number,
): { ranked: RankedFunction[]; background: RankedFunction[] } {
  const scored: RankedFunction[] = functions.map((f) => ({
    ...f,
    call_site_count: callCounts.get(f.qualname) ?? 0,
    score: scoreFunction(f, callCounts.get(f.qualname) ?? 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return {
    ranked: scored.slice(0, topK),
    background: scored.slice(topK),
  };
}
