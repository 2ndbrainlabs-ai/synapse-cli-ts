// src/session/surface-cache.ts
//
// Durable, cross-invocation cache of the last completed discovery pass for a
// repo. Unlike the per-session JSONL ledger (session/ledger.ts), which only
// survives to be replayed via `--resume` of the *same* unfinished session,
// this cache survives across separate, completed `synapse build` runs so
// discovery doesn't have to re-run on every invocation.
//
// Lives at `.synapse/surface_cache.json`. It holds what the extractor found
// (endpoints/functions per file, keyed by path + SHA-256), never source code.
// Anything unreadable, from another repo or an older format reads as "no
// cache", so the build falls back to a normal discovery instead of failing.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSurfaceCachePath } from "../config/paths.js";
import type {
  HttpEndpoint,
  SupportedLanguage,
  SurfaceFunction,
  SurfaceManifest,
} from "../extractors/core/surface-manifest.js";
import type { LedgerRecord, ResumeState } from "./ledger.js";

export interface SurfaceCacheFileEntry {
  sha: string;
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
}

/** Bump when the on-disk shape changes; older files are ignored (rediscover). */
export const SURFACE_CACHE_VERSION = 1;

/** The key a cache is valid for: the project directory. Not the session
 *  repo hash, which follows git HEAD: keying on it would throw the cache away
 *  on every commit, and SYN-8 asks for a rescan only on `--discover`. */
export function surfaceCacheKey(workingDir: string): string {
  return createHash("sha256").update(path.resolve(workingDir)).digest("hex");
}

export interface SurfaceCacheFile {
  version: typeof SURFACE_CACHE_VERSION;
  /** surfaceCacheKey() of the project the cache was written for. */
  repo_hash: string;
  language: SupportedLanguage;
  framework: string | null;
  package_import_root: string;
  /** Whether functions were captured when this cache was built (Custom-mode data present). */
  captured_functions: boolean;
  files: Record<string, SurfaceCacheFileEntry>;
  /** Total lines of the files behind this result (SurfaceManifest.lines_scanned,
   *  SYN-315). Reported through the lines-delta baseline on reuse, which only
   *  sends lines that were never accepted, so nothing is charged twice. */
  lines_scanned: number;
  updated_at: number;
}

function isEntry(v: unknown): v is SurfaceCacheFileEntry {
  const e = v as SurfaceCacheFileEntry | null;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.sha === "string" &&
    Array.isArray(e.endpoints) &&
    Array.isArray(e.functions)
  );
}

function isCacheFile(v: unknown): v is SurfaceCacheFile {
  const c = v as SurfaceCacheFile | null;
  return (
    !!c &&
    typeof c === "object" &&
    c.version === SURFACE_CACHE_VERSION &&
    typeof c.repo_hash === "string" &&
    typeof c.language === "string" &&
    typeof c.package_import_root === "string" &&
    typeof c.captured_functions === "boolean" &&
    typeof c.lines_scanned === "number" &&
    typeof c.updated_at === "number" &&
    !!c.files &&
    typeof c.files === "object" &&
    !Array.isArray(c.files) &&
    Object.values(c.files).every(isEntry)
  );
}

export function readSurfaceCache(workingDir: string, repoHash: string): SurfaceCacheFile | null {
  const filePath = getSurfaceCachePath(workingDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isCacheFile(parsed) || parsed.repo_hash !== repoHash) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSurfaceCache(workingDir: string, cache: SurfaceCacheFile): void {
  const filePath = getSurfaceCachePath(workingDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Best-effort — a stale/missing cache just means the next build re-discovers.
  }
}

/** Can this cache stand in for a discovery pass in the given mode? Custom
 *  needs function data; a result with nothing in it is never reused, so a
 *  repo that had no endpoints yet is rescanned instead of staying empty. */
export function isCacheUsable(cache: SurfaceCacheFile | null, captureFunctions: boolean): boolean {
  if (!cache) return false;
  if (captureFunctions && !cache.captured_functions) return false;
  const entries = Object.values(cache.files);
  return captureFunctions
    ? entries.some((e) => e.endpoints.length > 0 || e.functions.length > 0)
    : entries.some((e) => e.endpoints.length > 0);
}

export function cacheToManifest(
  cache: SurfaceCacheFile,
  opts: { captureFunctions?: boolean } = {},
): SurfaceManifest {
  const captureFunctions = opts.captureFunctions !== false;
  const endpoints: HttpEndpoint[] = [];
  const functions: SurfaceFunction[] = [];
  for (const entry of Object.values(cache.files)) {
    endpoints.push(...entry.endpoints);
    if (captureFunctions) functions.push(...entry.functions);
  }
  return {
    language: cache.language,
    framework: cache.framework,
    endpoints,
    functions,
    package_import_root: cache.package_import_root,
    lines_scanned: cache.lines_scanned,
  };
}

/** "Oct 30, 2026, 1:05 PM" style, for the reuse hint. */
export function formatDiscoveredAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Reshape the cache into the same `ResumeState.scanned` map the streamed
 *  extractors already consult for their SHA skip/merge check, so a fresh
 *  (non-`--resume`) session can still reuse prior results. */
export function cacheToResumeScanned(
  cache: SurfaceCacheFile,
): Map<string, Extract<LedgerRecord, { type: "file_scanned" }>> {
  const scanned = new Map<string, Extract<LedgerRecord, { type: "file_scanned" }>>();
  const now = cache.updated_at;
  for (const [relPath, entry] of Object.entries(cache.files)) {
    scanned.set(relPath, {
      type: "file_scanned",
      path: relPath,
      sha: entry.sha,
      endpoints: entry.endpoints,
      functions: entry.functions,
      scanned_at: now,
      elapsed_ms: 0,
    });
  }
  return scanned;
}

export function resumeStateFromCache(cache: SurfaceCacheFile): ResumeState {
  return {
    meta: null,
    scanned: cacheToResumeScanned(cache),
    skipped: new Map(),
    shards: [],
    completed: false,
  };
}

/** Build the next cache snapshot from a completed (or partially completed but
 *  non-aborted) session's ledger, carrying over unchanged entries from the
 *  previous cache for files that were skipped (not re-appended this run).
 *  A carried-over entry is kept only if this scan still produced results from
 *  that file, so deleted files (and files whose endpoints were all removed)
 *  drop out instead of resurfacing on every reuse. */
export function buildSurfaceCache(opts: {
  repoHash: string;
  manifest: SurfaceManifest;
  ledgerRecords: LedgerRecord[];
  previous: SurfaceCacheFile | null;
  captureFunctions: boolean;
}): SurfaceCacheFile {
  const files: Record<string, SurfaceCacheFileEntry> = {};

  // Files this scan produced results from (parsed or replayed unchanged).
  const seen = new Set<string>();
  for (const e of opts.manifest.endpoints) seen.add(e.file_path);
  for (const f of opts.manifest.functions) seen.add(f.file_path);

  // Start from the previous cache so unchanged (skipped-this-run) files persist.
  if (opts.previous) {
    for (const [relPath, entry] of Object.entries(opts.previous.files)) {
      if (seen.has(relPath)) files[relPath] = entry;
    }
  }

  for (const record of opts.ledgerRecords) {
    if (record.type === "file_scanned") {
      files[record.path] = {
        sha: record.sha,
        endpoints: record.endpoints,
        functions: record.functions,
      };
    }
  }

  return {
    version: SURFACE_CACHE_VERSION,
    repo_hash: opts.repoHash,
    language: opts.manifest.language,
    // Framework comes from parse hits; a rescan where every file was
    // unchanged parses nothing, so keep the one found last time.
    framework: opts.manifest.framework ?? opts.previous?.framework ?? null,
    package_import_root: opts.manifest.package_import_root,
    captured_functions: opts.captureFunctions,
    files,
    lines_scanned: opts.manifest.lines_scanned ?? 0,
    updated_at: Date.now(),
  };
}
