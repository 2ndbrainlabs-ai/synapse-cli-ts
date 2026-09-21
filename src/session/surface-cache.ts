// src/session/surface-cache.ts
//
// Durable, cross-invocation cache of the last completed discovery pass for a
// repo. Unlike the per-session JSONL ledger (session/ledger.ts), which only
// survives to be replayed via `--resume` of the *same* unfinished session,
// this cache survives across separate, completed `synapse build` runs so
// discovery doesn't have to re-run on every invocation.

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

export interface SurfaceCacheFile {
  repo_hash: string;
  language: SupportedLanguage;
  framework: string | null;
  package_import_root: string;
  /** Whether functions were captured when this cache was built (Custom-mode data present). */
  captured_functions: boolean;
  files: Record<string, SurfaceCacheFileEntry>;
  updated_at: number;
}

export function readSurfaceCache(workingDir: string, repoHash: string): SurfaceCacheFile | null {
  const filePath = getSurfaceCachePath(workingDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as SurfaceCacheFile;
    if (!parsed || parsed.repo_hash !== repoHash || typeof parsed.files !== "object") return null;
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

export function cacheToManifest(cache: SurfaceCacheFile): SurfaceManifest {
  const endpoints: HttpEndpoint[] = [];
  const functions: SurfaceFunction[] = [];
  for (const entry of Object.values(cache.files)) {
    endpoints.push(...entry.endpoints);
    functions.push(...entry.functions);
  }
  return {
    language: cache.language,
    framework: cache.framework,
    endpoints,
    functions,
    package_import_root: cache.package_import_root,
  };
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
 *  previous cache for files that were skipped (not re-appended this run). */
export function buildSurfaceCache(opts: {
  repoHash: string;
  manifest: SurfaceManifest;
  ledgerRecords: LedgerRecord[];
  previous: SurfaceCacheFile | null;
  captureFunctions: boolean;
}): SurfaceCacheFile {
  const files: Record<string, SurfaceCacheFileEntry> = {};

  // Start from the previous cache so unchanged (skipped-this-run) files persist.
  if (opts.previous) {
    for (const [relPath, entry] of Object.entries(opts.previous.files)) {
      files[relPath] = entry;
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
    repo_hash: opts.repoHash,
    language: opts.manifest.language,
    framework: opts.manifest.framework,
    package_import_root: opts.manifest.package_import_root,
    captured_functions: opts.captureFunctions,
    files,
    updated_at: Date.now(),
  };
}
