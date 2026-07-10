import fs from "node:fs";
import path from "node:path";
import { extensionsFor } from "./file-types.js";

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  context_before: string[];
  context_after: string[];
}

export interface GrepOptions {
  path?: string;
  file_type?: string;
  context_lines?: number;
  max_results?: number;
  offset?: number;
  case_sensitive?: boolean;
}

export interface GrepResult {
  matches: GrepMatch[];
  total: number;
  truncated: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".synapse", "venv", ".venv",
  "env", ".env", "dist", "build", ".next", ".cache", "target",
  ".tox", ".pytest_cache", ".mypy_cache",
]);

export function grepSearch(
  pattern: string,
  baseDir: string,
  opts: GrepOptions = {},
): GrepResult {
  const {
    path: subPath,
    file_type,
    context_lines = 0,
    max_results = 100,
    offset = 0,
    case_sensitive = false,
  } = opts;

  const searchDir = subPath ? path.resolve(baseDir, subPath) : baseDir;
  const allowedExts = extensionsFor(file_type);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, case_sensitive ? "" : "i");
  } catch {
    return { matches: [], total: 0, truncated: false };
  }

  const allMatches: GrepMatch[] = [];

  function walkAndSearch(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (allMatches.length >= (offset + max_results) * 3) return; // Early exit

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walkAndSearch(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowedExts && !allowedExts.includes(ext)) continue;

        const filePath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, filePath);

        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const ctxBefore: string[] = [];
              const ctxAfter: string[] = [];

              if (context_lines > 0) {
                for (let b = Math.max(0, i - context_lines); b < i; b++) {
                  ctxBefore.push(lines[b]);
                }
                for (let a = i + 1; a <= Math.min(lines.length - 1, i + context_lines); a++) {
                  ctxAfter.push(lines[a]);
                }
              }

              allMatches.push({
                file: relPath,
                line: i + 1,
                content: lines[i],
                context_before: ctxBefore,
                context_after: ctxAfter,
              });
            }
          }
        } catch {
          // Skip unreadable files (binary, permission errors)
        }
      }
    }
  }

  walkAndSearch(searchDir);

  const total = allMatches.length;
  const truncated = total > offset + max_results;
  const matches = allMatches.slice(offset, offset + max_results);

  return { matches, total, truncated };
}
