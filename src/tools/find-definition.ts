import fs from "node:fs";
import path from "node:path";
import { SYMBOL_PATTERNS } from "./file-types.js";

// Union of every extension we know how to parse for symbols.
// Sourced from the shared file-types registry so adding a language is
// one entry there, not here.
const CODE_EXTS = new Set(Object.keys(SYMBOL_PATTERNS));

export interface DefinitionResult {
  file: string;
  line: number;
  signature: string;
  context: string;
}

export interface FindDefinitionResult {
  definitions: DefinitionResult[];
  count: number;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".synapse", "venv", ".venv",
  "env", "dist", "build", ".next", ".cache", "target",
]);

// Patterns that indicate a definition (not a usage)
function buildDefinitionPatterns(symbol: string): RegExp[] {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`, "m"),           // Python def
    new RegExp(`^\\s*class\\s+${escaped}\\b`, "m"),                           // Python/JS/TS class
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*[<(]`, "m"),  // JS/TS function
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=`, "m"),          // JS/TS variable
    new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`, "m"),    // Rust fn
    new RegExp(`^func\\s+(?:\\([^)]+\\)\\s+)?${escaped}\\s*\\(`, "m"),         // Go func
    new RegExp(`^type\\s+${escaped}\\s+`, "m"),                                // Go type
  ];
}

export function findDefinition(
  symbol: string,
  baseDir: string,
  opts: { scope?: string } = {},
): FindDefinitionResult {
  const patterns = buildDefinitionPatterns(symbol);
  const definitions: DefinitionResult[] = [];
  const searchDir = opts.scope ? path.resolve(baseDir, opts.scope) : baseDir;

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
      const line = lines[i];
      for (const pat of patterns) {
        if (pat.test(line)) {
          // Grab a few lines of context
          const contextEnd = Math.min(i + 5, lines.length);
          const context = lines.slice(i, contextEnd).join("\n");

          definitions.push({
            file: relPath,
            line: i + 1,
            signature: line.trim(),
            context,
          });
          break;
        }
      }
    }
  }

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
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          searchFile(path.join(dir, entry.name));
        }
      }
    }
  }

  walk(searchDir);
  return { definitions, count: definitions.length };
}
