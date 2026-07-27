import fs from "node:fs";
import path from "node:path";
import { SYMBOL_PATTERNS, type SymbolPattern } from "./file-types.js";

export interface SymbolInfo {
  name: string;
  type: "function" | "class" | "method" | "variable";
  file: string;
  line: number;
  signature: string;
}

export interface ListSymbolsResult {
  symbols: SymbolInfo[];
  count: number;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".synapse", "venv", ".venv",
  "env", "dist", "build", ".next", ".cache", "target",
]);

export function listSymbols(
  baseDir: string,
  opts: { file_path?: string; directory?: string; pattern?: string } = {},
): ListSymbolsResult {
  const symbols: SymbolInfo[] = [];
  const nameFilter = opts.pattern ? new RegExp(opts.pattern, "i") : null;

  function extractFromFile(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    const patterns: SymbolPattern[] | undefined = SYMBOL_PATTERNS[ext];
    if (!patterns) return;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const relPath = path.relative(baseDir, filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      for (const pat of patterns) {
        const match = line.match(pat.regex);
        if (!match) continue;

        const name = (match[pat.nameGroupIndex] ?? "").trim();
        if (!name) break; // No name captured — avoid duplicate work

        // Callers filter private/dunder via `pattern`. We do NOT drop
        // underscored names here — that hides legitimate Python dunders
        // (__init__, __call__) that the agent needs to see.
        if (nameFilter && !nameFilter.test(name)) break;

        // Python method-vs-function heuristic (indented def under a class).
        let type = pat.type;
        if (ext === ".py" && pat.type === "function") {
          const indent = match[1] ?? "";
          if (indent.trim() === "" && indent.length > 0) type = "method";
        }

        symbols.push({
          name,
          type,
          file: relPath,
          line: i + 1,
          signature: line.trim().slice(0, 120),
        });
        break; // Only match first pattern per line
      }
    }
  }

  if (opts.file_path) {
    const absPath = path.isAbsolute(opts.file_path)
      ? opts.file_path
      : path.join(baseDir, opts.file_path);
    extractFromFile(absPath);
  } else {
    const scanDir = opts.directory
      ? path.resolve(baseDir, opts.directory)
      : baseDir;

    function walk(dir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          extractFromFile(path.join(dir, entry.name));
        }
      }
    }
    walk(scanDir);
  }

  return { symbols, count: symbols.length };
}
