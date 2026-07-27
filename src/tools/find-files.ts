import fs from "node:fs";
import path from "node:path";

export interface FindFilesResult {
  files: string[];
  count: number;
  truncated: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".synapse", "venv", ".venv",
  "env", ".env", "dist", "build", ".next", ".cache", "target",
  ".tox", ".pytest_cache", ".mypy_cache", "egg-info",
]);

const MAX_FILES = 100;

export function findFiles(
  pattern: string,
  baseDir: string,
): FindFilesResult {
  // Convert glob to regex: ** = any path, * = any name segment
  // Support patterns like: **/*.py, src/**/*.ts, *.json, config/*.yaml
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "(.+/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");

  const regex = new RegExp(`^${regexStr}$`);
  const results: { file: string; mtime: number }[] = [];

  function walk(dir: string, relPrefix: string): void {
    if (results.length >= MAX_FILES * 2) return; // Over-collect then sort

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (regex.test(relPath)) {
          let mtime = 0;
          try {
            mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs;
          } catch { /* skip */ }
          results.push({ file: relPath, mtime });
        }
      }
    }
  }

  walk(baseDir, "");

  // Sort by mtime descending (most recent first)
  results.sort((a, b) => b.mtime - a.mtime);

  const truncated = results.length > MAX_FILES;
  const files = results.slice(0, MAX_FILES).map((r) => r.file);

  return { files, count: files.length, truncated };
}
