import fs from "node:fs";
import path from "node:path";
import { extensionsFor } from "./file-types.js";

export interface UsageMatch {
  file: string;
  line: number;
  content: string;
}

export interface FindUsagesResult {
  usages: UsageMatch[];
  count: number;
  truncated: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".synapse", "venv", ".venv",
  "env", "dist", "build", ".next", ".cache", "target",
]);

const MAX_USAGES = 50;

export function findUsages(
  symbol: string,
  baseDir: string,
  opts: { file_type?: string } = {},
): FindUsagesResult {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the symbol as a word boundary (not inside another word)
  const usagePattern = new RegExp(`\\b${escaped}\\b`);

  // Patterns that indicate definitions (to EXCLUDE from usages)
  const defPatterns = [
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`),
    new RegExp(`^\\s*class\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*[<(]`),
    new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`),
    new RegExp(`^func\\s+(?:\\([^)]+\\)\\s+)?${escaped}\\s*\\(`),
    new RegExp(`^type\\s+${escaped}\\s+`),
  ];

  const allowedExts = extensionsFor(opts.file_type);

  const usages: UsageMatch[] = [];

  function searchFile(filePath: string): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const relPath = path.relative(baseDir, filePath);

    for (let i = 0; i < lines.length; i++) {
      if (usages.length >= MAX_USAGES) return;

      const line = lines[i];
      if (!usagePattern.test(line)) continue;

      // Exclude definition lines
      const isDef = defPatterns.some((p) => p.test(line));
      if (isDef) continue;

      usages.push({
        file: relPath,
        line: i + 1,
        content: line.trimEnd(),
      });
    }
  }

  function walk(dir: string): void {
    if (usages.length >= MAX_USAGES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (usages.length >= MAX_USAGES) return;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowedExts && !allowedExts.includes(ext)) continue;
        // Skip non-code files
        if (![".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".cs", ".rb"].includes(ext)) continue;
        searchFile(path.join(dir, entry.name));
      }
    }
  }

  walk(baseDir);
  return { usages, count: usages.length, truncated: usages.length >= MAX_USAGES };
}
