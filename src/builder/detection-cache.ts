/**
 * Endpoint detection with per-file mtime cache.
 *
 * Wraps the gRPC DetectEndpoints RPC: only sends functions from new or
 * modified files to the backend. Candidates for unchanged files are
 * returned from cache immediately.
 *
 * Ported from Python build_command.py::_detect_with_cache().
 */

import fs from "node:fs";
import path from "node:path";
import type { FunctionInfo } from "../parsers/types.js";
import { SynapseClient, type DetectResult } from "../grpc/client.js";
import { getBackendConfig } from "../config/manager.js";

export interface CachedDetection {
  file_mtimes: Record<string, number>;
  candidates: Record<string, unknown>[];
}

/**
 * Run DetectEndpoints RPC with a per-file mtime cache.
 */
export async function detectWithCache(
  allFunctions: FunctionInfo[],
  workingDir: string,
  projectSchema: string,
  cachePath: string,
): Promise<[Record<string, unknown>[], number]> {
  // Group functions by file
  const funcsByFile = new Map<string, FunctionInfo[]>();
  for (const fn of allFunctions) {
    const key = fn.filePath;
    if (!funcsByFile.has(key)) funcsByFile.set(key, []);
    funcsByFile.get(key)!.push(fn);
  }

  // Current mtimes
  const currentMtimes: Record<string, number> = {};
  for (const relPath of funcsByFile.keys()) {
    const absPath = path.isAbsolute(relPath)
      ? relPath
      : path.join(workingDir, relPath);
    try {
      currentMtimes[relPath] = fs.statSync(absPath).mtimeMs / 1000;
    } catch {
      currentMtimes[relPath] = 0;
    }
  }

  // Load cache
  let cachedMtimes: Record<string, number> = {};
  let cachedCandidates: Record<string, unknown>[] = [];
  if (fs.existsSync(cachePath)) {
    try {
      const raw: CachedDetection = JSON.parse(
        fs.readFileSync(cachePath, "utf-8"),
      );
      cachedMtimes = raw.file_mtimes ?? {};
      cachedCandidates = raw.candidates ?? [];
    } catch {
      // Corrupt cache -- treat as empty
    }
  }

  // Identify changed/new and deleted files
  const changedFiles = new Set<string>();
  for (const [rel, mtime] of Object.entries(currentMtimes)) {
    if (Math.abs(mtime - (cachedMtimes[rel] ?? -1)) > 0.001) {
      changedFiles.add(rel);
    }
  }
  const deletedFiles = new Set(
    Object.keys(cachedMtimes).filter((k) => !(k in currentMtimes)),
  );

  // Fast path: nothing changed and cache populated
  if (
    changedFiles.size === 0 &&
    deletedFiles.size === 0 &&
    cachedCandidates.length > 0
  ) {
    return [cachedCandidates, 0];
  }

  // Prune stale candidates
  const staleFiles = new Set([...changedFiles, ...deletedFiles]);
  const surviving = cachedCandidates.filter(
    (c) => !staleFiles.has((c.file_path as string) ?? ""),
  );

  // Collect functions from changed files
  const functionsToSend: FunctionInfo[] = [];
  for (const rel of changedFiles) {
    const fns = funcsByFile.get(rel);
    if (fns) functionsToSend.push(...fns);
  }

  let newCandidates: Record<string, unknown>[] = [];
  if (functionsToSend.length > 0) {
    const backend = getBackendConfig();
    const client = new SynapseClient({
      url: backend.url ?? undefined,
      host: backend.host ?? undefined,
      workingDir,
    });
    const result: DetectResult = await client.detect(
      functionsToSend as unknown as Record<string, unknown>[],
      workingDir,
      projectSchema,
    );
    if (result.error) throw new Error(result.error);
    newCandidates = result.candidates as unknown as Record<string, unknown>[];
  }

  // Merge and sort by confidence desc
  const merged = [...surviving, ...newCandidates];
  merged.sort(
    (a, b) =>
      ((b.confidence as number) ?? 0) - ((a.confidence as number) ?? 0),
  );

  // Persist updated cache
  try {
    fs.writeFileSync(
      cachePath,
      JSON.stringify(
        { file_mtimes: currentMtimes, candidates: merged },
        null,
        2,
      ),
    );
  } catch {
    // Non-fatal
  }

  return [merged, newCandidates.length];
}
