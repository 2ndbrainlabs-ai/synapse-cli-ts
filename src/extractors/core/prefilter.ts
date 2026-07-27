// src/extractors/core/prefilter.ts
//
// Byte-level marker sniff. For a 500k LOC repo (~20k .py files) we can't
// afford to hand every file to tree-sitter — 99% of them contain no route
// decorators. This walker:
//   1. Iterates the repo lazily with fs.opendir (async iterator, cheap).
//   2. Skips dir/name lists we already know are noise (SKIP_DIRS, tests).
//   3. Reads the first 64 KB of each survivor into a single reused buffer.
//   4. Runs an Aho-Corasick automaton for the needle set the caller supplies.
//   5. Yields `{path, sha, bytesRead}` for files that hit at least one needle
//      OR (in Custom mode) that contain `def ` / `async def ` / `class `.
//
// AbortSignal-aware; safe to interrupt mid-walk. Zero worker threads —
// tree-sitter itself is the bottleneck later, and the sniff is I/O bound.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AhoCorasick } from "./aho-corasick.js";

const HEAD_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Directories we never descend into. Copy of the SKIP_DIRS list in
// languages/python.ts — duplicated so this module has no circular import
// on languages. Keep them in sync.
export const DEFAULT_SKIP_DIRS = new Set([
  "__pycache__", ".git", ".venv", "venv", "node_modules", ".synapse",
  "env", ".env", "tests", "test", "testing", "dist", "build",
  ".egg-info", ".pytest_cache", ".mypy_cache", ".tox", "mcp",
]);

export const DEFAULT_SKIP_FILENAMES = new Set([
  "mcp_server.py", "setup.py", "conftest.py", "noxfile.py",
]);

export const DEFAULT_SKIP_FILE_PARTIALS = ["test_", "_test.py", "tests.py"];

export interface PrefilterMatch {
  /** Absolute path to the matched file. */
  path: string;
  /** Repo-relative path (used as the ledger key). */
  relPath: string;
  /** SHA-256 of the file's bytes we already read. Full-file if size < HEAD_BYTES; head-hash if larger. */
  sha: string;
  /** true when we hashed the full file (small file); false when only the 64KB head. */
  fullHashed: boolean;
  /** The bytes we actually read — reusable if the caller wants to parse without a second read. */
  head: Buffer;
  bytesRead: number;
}

export interface PrefilterOptions {
  workingDir: string;
  /** Include files whose head matches any of these byte strings (endpoint needles). */
  needles: readonly string[];
  /**
   * Optional second automaton. When supplied, files whose head matches EITHER
   * `needles` OR `extraNeedles` are yielded. Used in Custom mode to include
   * files that declare functions/classes even without route decorators.
   */
  extraNeedles?: readonly string[];
  signal?: AbortSignal;
  skipDirs?: Set<string>;
  skipFilenames?: Set<string>;
  skipFilePartials?: string[];
  /** Absolute cap on total files inspected (safety net for pathological repos). */
  maxFilesInspected?: number;
  /** Extensions to consider. Default: only .py in M1. */
  fileExtensions?: readonly string[];
}

export interface PrefilterProgress {
  filesSeen: number;
  filesMatched: number;
  filesSkipped: number;
}

/** Async iterator over survivor files. */
export async function* sniffCandidateFiles(
  opts: PrefilterOptions,
  onProgress?: (p: PrefilterProgress) => void,
): AsyncGenerator<PrefilterMatch, PrefilterProgress> {
  const workingDir = path.resolve(opts.workingDir);
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipFilenames = opts.skipFilenames ?? DEFAULT_SKIP_FILENAMES;
  const skipPartials = opts.skipFilePartials ?? DEFAULT_SKIP_FILE_PARTIALS;
  const extensions = opts.fileExtensions ?? [".py"];
  const maxFiles = opts.maxFilesInspected ?? 200_000;

  const primary = new AhoCorasick(opts.needles);
  const extra = opts.extraNeedles && opts.extraNeedles.length > 0
    ? new AhoCorasick(opts.extraNeedles)
    : null;

  // Single reused buffer for the head reads.
  const buf = Buffer.allocUnsafe(HEAD_BYTES);

  let filesSeen = 0;
  let filesMatched = 0;
  let filesSkipped = 0;

  const stack: string[] = [workingDir];

  while (stack.length > 0) {
    if (opts.signal?.aborted) break;
    const dir = stack.pop()!;

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      if (opts.signal?.aborted) break;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      // Extension gate first — cheapest test.
      const ext = path.extname(entry.name);
      if (!extensions.includes(ext)) continue;

      // Filename filters (tests, generated).
      if (skipFilenames.has(entry.name)) continue;
      if (skipPartials.some((p) => entry.name.includes(p))) continue;

      filesSeen++;

      if (filesSeen >= maxFiles) {
        onProgress?.({ filesSeen, filesMatched, filesSkipped });
        return { filesSeen, filesMatched, filesSkipped };
      }

      // Stat for size — skip oversized files.
      let size: number;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        filesSkipped++;
        continue;
      }
      if (size > MAX_FILE_BYTES && process.env.SYNAPSE_PREFILTER_FULL_READ !== "1") {
        filesSkipped++;
        continue;
      }

      // Read up to HEAD_BYTES into the reused buffer.
      let fh: fsp.FileHandle | null = null;
      let bytesRead = 0;
      try {
        fh = await fsp.open(full, "r");
        const readResult = await fh.read(buf, 0, HEAD_BYTES, 0);
        bytesRead = readResult.bytesRead;
      } catch {
        filesSkipped++;
        if (fh) await fh.close().catch(() => {});
        continue;
      } finally {
        // We keep fh open long enough to potentially re-use — but for the
        // prefilter we only need the head. Close now.
        if (fh) await fh.close().catch(() => {});
      }

      const slice = buf.subarray(0, bytesRead);
      const primaryHit = primary.hasMatch(slice, bytesRead);
      const extraHit = !primaryHit && extra ? extra.hasMatch(slice, bytesRead) : false;
      if (!primaryHit && !extraHit) continue;

      filesMatched++;
      if (onProgress && filesMatched % 8 === 0) {
        onProgress({ filesSeen, filesMatched, filesSkipped });
      }

      // Hash head; if the file fits inside HEAD_BYTES it's a full-file hash.
      const sha = createHash("sha256").update(slice).digest("hex");
      const fullHashed = size <= bytesRead;

      // Copy the head into a fresh buffer so callers can safely retain it —
      // the reusable `buf` is about to be overwritten by the next file.
      const headCopy = Buffer.from(slice);

      yield {
        path: full,
        relPath: path.relative(workingDir, full),
        sha,
        fullHashed,
        head: headCopy,
        bytesRead,
      };
    }
  }

  onProgress?.({ filesSeen, filesMatched, filesSkipped });
  return { filesSeen, filesMatched, filesSkipped };
}
