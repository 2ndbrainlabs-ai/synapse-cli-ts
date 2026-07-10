/**
 * Single registry of file-type extensions and symbol patterns.
 *
 * Every language-aware tool (grep-search, list-symbols, find-definition,
 * find-usages) imports from this module so adding a new language is a
 * two-line change (one entry in FILE_TYPES, one entry in SYMBOL_PATTERNS).
 *
 * Design principle from Claude Code: refuse to have language-specific code
 * paths inside the tool logic. All language variation is data.
 */

/**
 * Map short language keys to the file extensions they cover.
 * Keys should match what the backend agent will pass in `file_type` params.
 */
export const FILE_TYPES: Record<string, string[]> = {
  py: [".py"],
  python: [".py"],
  ts: [".ts", ".tsx"],
  typescript: [".ts", ".tsx"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  go: [".go"],
  java: [".java"],
  cs: [".cs", ".csx"],
  csharp: [".cs", ".csx"],
  rust: [".rs"],
  rb: [".rb"],
  ruby: [".rb"],
  cpp: [".cpp", ".cc", ".cxx", ".h", ".hpp"],
  c: [".c", ".h"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  toml: [".toml"],
  md: [".md", ".markdown"],
  sql: [".sql"],
};

/**
 * Symbol declaration patterns per file extension.
 *
 * Each pattern captures a single symbol name in group 1 (or higher — see
 * `nameGroupIndex` if a language ever needs more than one group).
 *
 * Note: These are regex-based (not tree-sitter) because the CLI stays lean.
 * They're good enough for common cases and can be augmented later if we
 * want tree-sitter-quality precision.
 */
export interface SymbolPattern {
  regex: RegExp;
  nameGroupIndex: number;
  type: "function" | "class" | "method" | "variable";
}

// Shared TS/JS pattern set — used by .ts/.tsx/.js/.jsx/.mjs/.cjs.
const TS_JS_PATTERNS: SymbolPattern[] = [
  {
    regex: /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/,
    nameGroupIndex: 2,
    type: "function",
  },
  {
    regex: /^(\s*)(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    nameGroupIndex: 2,
    type: "class",
  },
  {
    regex: /^(\s*)(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    nameGroupIndex: 2,
    type: "function",
  },
];

export const SYMBOL_PATTERNS: Record<string, SymbolPattern[]> = {
  ".py": [
    { regex: /^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/, nameGroupIndex: 3, type: "function" },
    { regex: /^(\s*)class\s+(\w+)(?:\([^)]*\))?:/, nameGroupIndex: 2, type: "class" },
  ],
  ".ts": TS_JS_PATTERNS,
  ".tsx": TS_JS_PATTERNS,
  ".js": TS_JS_PATTERNS,
  ".jsx": TS_JS_PATTERNS,
  ".mjs": TS_JS_PATTERNS,
  ".cjs": TS_JS_PATTERNS,
  ".go": [
    { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/, nameGroupIndex: 1, type: "function" },
    { regex: /^type\s+(\w+)\s+struct/, nameGroupIndex: 1, type: "class" },
    { regex: /^type\s+(\w+)\s+interface/, nameGroupIndex: 1, type: "class" },
  ],
  ".java": [
    {
      regex: /^(\s*)(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/,
      nameGroupIndex: 2,
      type: "method",
    },
    {
      regex: /^(\s*)(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/,
      nameGroupIndex: 2,
      type: "class",
    },
  ],
  ".cs": [
    {
      regex: /^(\s*)(?:public|private|protected|internal)?\s*(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/,
      nameGroupIndex: 2,
      type: "method",
    },
    {
      regex: /^(\s*)(?:public|private|internal)?\s*(?:abstract\s+)?class\s+(\w+)/,
      nameGroupIndex: 2,
      type: "class",
    },
  ],
  ".rs": [
    { regex: /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, nameGroupIndex: 2, type: "function" },
    { regex: /^(\s*)(?:pub\s+)?struct\s+(\w+)/, nameGroupIndex: 2, type: "class" },
    { regex: /^(\s*)(?:pub\s+)?trait\s+(\w+)/, nameGroupIndex: 2, type: "class" },
    { regex: /^(\s*)(?:pub\s+)?impl\s+(\w+)/, nameGroupIndex: 2, type: "class" },
  ],
};

/**
 * Resolve the language key from a file path.  Returns the short key
 * ("py", "ts", etc.) or null when the extension is unknown.
 */
export function inferLanguageKey(filePath: string): string | null {
  const ext = filePathExt(filePath);
  for (const [key, exts] of Object.entries(FILE_TYPES)) {
    if (exts.includes(ext)) return key;
  }
  return null;
}

/**
 * Convert a caller-supplied `file_type` (e.g. "py", "javascript") into the
 * list of concrete file extensions to allow.  Unknown keys return null so
 * callers can fall back to "search everything".
 */
export function extensionsFor(fileType: string | undefined): string[] | null {
  if (!fileType) return null;
  return FILE_TYPES[fileType.toLowerCase()] ?? null;
}

function filePathExt(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return "";
  return filePath.slice(idx).toLowerCase();
}
