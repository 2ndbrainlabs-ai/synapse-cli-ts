import fs from "node:fs";
import path from "node:path";

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

// Language-aware patterns for extracting declarations
const DECLARATION_PATTERNS: Record<string, RegExp[]> = {
  ".py": [
    /^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/,      // Python functions
    /^(\s*)class\s+(\w+)(?:\([^)]*\))?:/,               // Python classes
  ],
  ".ts": [
    /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/,   // TS functions
    /^(\s*)(?:export\s+)?class\s+(\w+)/,                           // TS classes
    /^(\s*)(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/,  // Arrow functions
  ],
  ".js": [
    /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
    /^(\s*)(?:export\s+)?class\s+(\w+)/,
    /^(\s*)(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
  ],
  ".go": [
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/,      // Go functions/methods
    /^type\s+(\w+)\s+struct/,                            // Go structs
    /^type\s+(\w+)\s+interface/,                         // Go interfaces
  ],
  ".java": [
    /^(\s*)(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/,  // Java methods
    /^(\s*)(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/,          // Java classes
  ],
  ".rs": [
    /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,         // Rust functions
    /^(\s*)(?:pub\s+)?struct\s+(\w+)/,                   // Rust structs
    /^(\s*)(?:pub\s+)?trait\s+(\w+)/,                    // Rust traits
    /^(\s*)(?:pub\s+)?impl\s+(\w+)/,                     // Rust impls
  ],
};

export function listSymbols(
  baseDir: string,
  opts: { file_path?: string; directory?: string; pattern?: string } = {},
): ListSymbolsResult {
  const symbols: SymbolInfo[] = [];
  const nameFilter = opts.pattern ? new RegExp(opts.pattern, "i") : null;

  function extractFromFile(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    const patterns = DECLARATION_PATTERNS[ext];
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
        const match = line.match(pat);
        if (!match) continue;

        // Extract name depending on pattern structure
        let name = "";
        let type: SymbolInfo["type"] = "function";

        if (ext === ".py") {
          if (line.includes("class ")) {
            const cm = line.match(/class\s+(\w+)/);
            name = cm?.[1] ?? "";
            type = "class";
          } else {
            name = match[3] ?? match[2] ?? "";
            type = (match[1] ?? "").trim() ? "method" : "function";
          }
        } else if (ext === ".go") {
          name = match[1] ?? "";
          type = line.includes("struct") ? "class" : line.includes("interface") ? "class" : "function";
        } else if (ext === ".rs") {
          name = match[2] ?? "";
          type = (line.includes("struct") || line.includes("trait") || line.includes("impl")) ? "class" : "function";
        } else {
          // TS/JS/Java
          name = match[2] ?? "";
          type = line.includes("class") ? "class" : "function";
        }

        if (!name || name.startsWith("_")) break; // Skip private, avoid duplicates from multi-pattern

        if (nameFilter && !nameFilter.test(name)) break;

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
