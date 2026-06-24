/**
 * Query expander — builds context bundle from a free-text query.
 *
 * 5-step retrieval pipeline:
 *   1. Semantic vector search (LanceDB) on expanded terms
 *   2. Ripgrep / Node fallback exact-match search
 *   3. __init__.py public-export scan for API-tier boost
 *   4. Recency-blended re-ranking (70% semantic + 20% recency + 10% export)
 *   5. LLM side-call (Haiku) to select best candidates
 *
 * Ported from Python utils/query_expander.py.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildContextBundle, type ContextBundle, type EndpointLike } from "./context-builder.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "to", "in", "of", "with",
  "that", "this", "it", "is", "be", "are", "was", "were", "has",
  "have", "do", "does", "my", "me", "i", "we", "you", "your",
  "their", "from", "on", "at", "by", "as", "all", "some", "can",
  "will", "would", "should", "create", "make", "build", "generate",
  "get", "set",
]);

const DOMAIN_EXPANSIONS: Record<string, string[]> = {
  database: ["query", "execute", "fetch", "records", "table", "sql", "db"],
  search: ["find", "lookup", "query", "filter", "index", "retrieval"],
  file: ["read", "write", "open", "path", "directory", "filesystem"],
  api: ["endpoint", "request", "response", "http", "client", "rest"],
  auth: ["login", "token", "authenticate", "permission", "user"],
  cache: ["redis", "store", "expire", "hit", "miss", "invalidate"],
  email: ["send", "smtp", "message", "template", "notify"],
  image: ["process", "resize", "upload", "thumbnail", "transform"],
  data: ["process", "transform", "parse", "convert", "export", "import"],
  vector: ["embed", "similarity", "semantic", "qdrant", "index", "search"],
  nlp: ["text", "tokenize", "parse", "classify", "extract", "summarize"],
  ml: ["predict", "train", "model", "inference", "score", "feature"],
  linkedin: ["post", "publish", "share", "profile", "connect", "message"],
  social: ["post", "share", "publish", "feed", "profile"],
  post: ["create", "publish", "write", "send", "submit"],
  send: ["post", "deliver", "transmit", "dispatch", "publish"],
};

const SEMANTIC_WEIGHT = 0.70;
const RECENCY_WEIGHT = 0.20;
const EXPORT_BOOST = 0.10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RankedChunk {
  name: string;
  file_path: string;
  signature: string;
  docstring: string;
  code: string;
  type: string;
  start_line: number;
  end_line: number;
  score: number;
  mtime: number;
  recency_score?: number;
  blended_score?: number;
}

const SKIP_DIRS = new Set([
  "__pycache__", ".git", ".venv", "venv", "node_modules",
  ".synapse", "env", ".env",
]);

// ---------------------------------------------------------------------------
// Query expansion
// ---------------------------------------------------------------------------

export function expandQueryForSearch(userQuery: string): string[] {
  const queryLower = userQuery.toLowerCase();
  const rawTokens = queryLower.split(/[^a-z0-9]+/);
  const baseTerms = rawTokens.filter((t) => t && !STOPWORDS.has(t) && t.length > 2);

  const expanded: string[] = [...baseTerms];
  for (const token of baseTerms) {
    if (DOMAIN_EXPANSIONS[token]) {
      expanded.push(...DOMAIN_EXPANSIONS[token]);
    } else {
      for (const [domain, extras] of Object.entries(DOMAIN_EXPANSIONS)) {
        if (domain.includes(token) || token.includes(domain)) {
          expanded.push(...extras.slice(0, 3));
          break;
        }
      }
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of expanded) {
    if (!seen.has(term)) {
      seen.add(term);
      result.push(term);
    }
  }

  return [userQuery, ...result.filter((t) => t !== userQuery)].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Cardinality inference
// ---------------------------------------------------------------------------

function inferMaxCandidates(userQuery: string): number {
  const q = userQuery.toLowerCase();
  const singlePhrases = [
    "one tool", "single tool", "just one", "one single", "only one",
    "a single", "one mcp", "1 tool",
  ];
  if (singlePhrases.some((p) => q.includes(p))) return 3;

  const fewPhrases = ["two tools", "three tools", "a few tools", "couple of"];
  if (fewPhrases.some((p) => q.includes(p))) return 5;

  return 10;
}

// ---------------------------------------------------------------------------
// Public exports scan
// ---------------------------------------------------------------------------

function scanPublicExports(workingDir: string): Set<string> {
  const exported = new Set<string>();

  let parser: any;
  try {
    const TreeSitter = require("tree-sitter");
    const Python = require("tree-sitter-python");
    parser = new TreeSitter();
    parser.setLanguage(Python);
  } catch {
    return exported;
  }

  function walkDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    let hasInit = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walkDir(path.join(dir, entry.name));
        }
      } else if (entry.name === "__init__.py") {
        hasInit = true;
      }
    }

    if (!hasInit) return;

    const initPath = path.join(dir, "__init__.py");
    let source: string;
    try {
      source = fs.readFileSync(initPath, "utf-8");
    } catch {
      return;
    }

    let tree: any;
    try {
      tree = parser.parse(source);
    } catch {
      return;
    }

    const root = tree.rootNode;
    const codeBytes = Buffer.from(source, "utf-8");

    for (let i = 0; i < root.childCount; i++) {
      const node = root.child(i);

      // __all__ = ["name1", "name2"]
      if (node.type === "expression_statement") {
        const expr = node.child(0);
        if (expr?.type === "assignment") {
          const left = expr.childForFieldName("left");
          const right = expr.childForFieldName("right");
          if (
            left?.type === "identifier" &&
            codeBytes.subarray(left.startIndex, left.endIndex).toString("utf-8") === "__all__" &&
            (right?.type === "list" || right?.type === "tuple")
          ) {
            for (let j = 0; j < right.childCount; j++) {
              const elt = right.child(j);
              if (elt?.type === "string") {
                const raw = codeBytes.subarray(elt.startIndex, elt.endIndex).toString("utf-8");
                const val = raw.replace(/^['"]|['"]$/g, "");
                if (val) exported.add(val.toLowerCase());
              }
            }
          }
        }
      }

      // from .submodule import name (re-exports)
      if (node.type === "import_from_statement") {
        const text = codeBytes.subarray(node.startIndex, node.endIndex).toString("utf-8");
        if (text.match(/^from\s+\./)) {
          for (let j = 0; j < node.childCount; j++) {
            const child = node.child(j);
            if (child.type === "dotted_name" || child.type === "identifier") {
              const prev = child.previousSibling;
              if (prev && codeBytes.subarray(prev.startIndex, prev.endIndex).toString("utf-8") === "import") {
                const name = codeBytes.subarray(child.startIndex, child.endIndex).toString("utf-8");
                if (name !== "*") exported.add(name.toLowerCase());
              }
            } else if (child.type === "aliased_import") {
              const aliasNode = child.childForFieldName("alias");
              const nameNode = child.childForFieldName("name");
              const effective = aliasNode
                ? codeBytes.subarray(aliasNode.startIndex, aliasNode.endIndex).toString("utf-8")
                : nameNode
                  ? codeBytes.subarray(nameNode.startIndex, nameNode.endIndex).toString("utf-8")
                  : "";
              if (effective && effective !== "*") exported.add(effective.toLowerCase());
            }
          }
        }
      }
    }
  }

  walkDir(workingDir);
  return exported;
}

// ---------------------------------------------------------------------------
// Ripgrep search
// ---------------------------------------------------------------------------

function ripgrepSearch(
  keywords: string[],
  workingDir: string,
  maxResults: number = 20,
): RankedChunk[] {
  if (keywords.length === 0) return [];

  const seen = new Set<string>();
  const results: RankedChunk[] = [];

  const kwPattern = keywords.slice(0, 5).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = `(?:async\\s+)?def\\s+\\w*(?:${kwPattern})\\w*\\s*\\(|class\\s+\\w*(?:${kwPattern})\\w*`;

  function parseLine(line: string): RankedChunk | null {
    const parts = line.split(":");
    if (parts.length < 3) return null;
    const filePath = parts[0];
    const content = parts.slice(2).join(":");
    if (!filePath.endsWith(".py")) return null;

    const m = content.match(/(?:async\s+)?def\s+(\w+)|class\s+(\w+)/);
    if (!m) return null;
    const name = m[1] ?? m[2];
    const key = `${filePath}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);

    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs / 1000;
    } catch { /* skip */ }

    return {
      name,
      file_path: filePath,
      signature: content.trim(),
      docstring: "",
      code: "",
      type: m[1] ? "function" : "class",
      start_line: parseInt(parts[1], 10) || 0,
      end_line: 0,
      score: 0,
      mtime,
    };
  }

  // Try ripgrep
  try {
    const output = execFileSync("rg", [
      "--line-number", "--no-heading", "--color=never",
      "--type", "py", "--ignore-case",
      "-e", pattern, workingDir,
    ], { encoding: "utf-8", timeout: 10000 });

    for (const line of output.split("\n")) {
      if (results.length >= maxResults) break;
      const r = parseLine(line);
      if (r) results.push(r);
    }
    return results;
  } catch {
    // Ripgrep not available — fall through to manual walk
  }

  // Python-walk fallback
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "i");
  } catch {
    return results;
  }

  function walkDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walkDir(fullPath);
        }
        continue;
      }

      if (!entry.name.endsWith(".py")) continue;

      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) return;
        if (!compiled.test(lines[i])) continue;

        const m = lines[i].match(/(?:async\s+)?def\s+(\w+)|class\s+(\w+)/);
        if (!m) continue;
        const name = m[1] ?? m[2];
        const key = `${fullPath}::${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let mtime = 0;
        try {
          mtime = fs.statSync(fullPath).mtimeMs / 1000;
        } catch { /* skip */ }

        results.push({
          name,
          file_path: fullPath,
          signature: lines[i].trim(),
          docstring: "",
          code: "",
          type: m[1] ? "function" : "class",
          start_line: i + 1,
          end_line: 0,
          score: 0,
          mtime,
        });
      }
    }
  }

  walkDir(workingDir);
  return results;
}

// ---------------------------------------------------------------------------
// Recency normalization
// ---------------------------------------------------------------------------

function normalizeRecency(chunks: RankedChunk[]): RankedChunk[] {
  const mtimes = chunks.map((c) => c.mtime);
  const known = mtimes.filter((m) => m > 0);

  if (known.length < 2) {
    for (const c of chunks) c.recency_score = 0.5;
    return chunks;
  }

  const minT = Math.min(...known);
  const maxT = Math.max(...known);
  const span = maxT - minT || 1;

  for (const c of chunks) {
    if (c.mtime <= 0) {
      c.recency_score = 0.5;
    } else {
      c.recency_score = (c.mtime - minT) / span;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Blended ranking
// ---------------------------------------------------------------------------

function blendAndRank(chunks: RankedChunk[], exportedNames: Set<string>): RankedChunk[] {
  normalizeRecency(chunks);

  for (const c of chunks) {
    const semantic = c.score ?? 0;
    const recency = c.recency_score ?? 0.5;
    const exportBoost = exportedNames.has((c.name ?? "").toLowerCase()) ? EXPORT_BOOST : 0;
    c.blended_score = SEMANTIC_WEIGHT * semantic + RECENCY_WEIGHT * recency + exportBoost;
  }

  chunks.sort((a, b) => (b.blended_score ?? 0) - (a.blended_score ?? 0));
  return chunks;
}

// ---------------------------------------------------------------------------
// LLM candidate selection
// ---------------------------------------------------------------------------

async function llmSelectCandidates(
  userQuery: string,
  candidates: RankedChunk[],
  apiKey: string,
  maxSelect: number,
): Promise<RankedChunk[]> {
  if (!candidates.length) return candidates;
  if (!apiKey) return candidates.slice(0, maxSelect);
  if (candidates.length <= maxSelect) return candidates;

  const manifestLines: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const fp = c.file_path ? path.basename(c.file_path) : "?";
    const sig = c.signature || `def ${c.name}(...)`;
    const doc = (c.docstring ?? "").split("\n")[0].slice(0, 80);
    let line = `[${i}] ${c.name}  (${fp})  ${sig}`;
    if (doc) line += `  — ${doc}`;
    manifestLines.push(line);
  }

  const prompt =
    `User requirement: "${userQuery}"\n\n` +
    `Available functions (index, name, file, signature):\n${manifestLines.join("\n")}\n\n` +
    `Select the ${maxSelect} function(s) that BEST satisfy the requirement.\n` +
    `Reply with ONLY a JSON array of indices, e.g. [2, 0, 5]. No explanation.`;

  try {
    const { getApiUrl } = await import("../config/manager.js");
    const apiUrl = getApiUrl();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(`${apiUrl}/telemetry/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ prompt, max_select: maxSelect }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) return candidates.slice(0, maxSelect);

    const data = await resp.json();
    const raw: string = data.result ?? "";

    const indices = parseIndexList(raw, candidates.length);
    if (indices.length === 0) return candidates.slice(0, maxSelect);

    return indices.slice(0, maxSelect).map((i) => candidates[i]);
  } catch {
    return candidates.slice(0, maxSelect);
  }
}

function parseIndexList(text: string, maxIdx: number): number[] {
  const bracketMatch = text.match(/\[([^\]]+)\]/);
  const numbers = bracketMatch
    ? bracketMatch[1].match(/\d+/g)
    : text.match(/\d+/g);

  if (!numbers) return [];

  const indices: number[] = [];
  const seen = new Set<number>();
  for (const n of numbers) {
    const idx = parseInt(n, 10);
    if (idx >= 0 && idx < maxIdx && !seen.has(idx)) {
      indices.push(idx);
      seen.add(idx);
    }
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Signature metadata parsing
// ---------------------------------------------------------------------------

function parseSignatureMetadata(signature: string): { isAsync: boolean; returnType: string } {
  const sig = (signature ?? "").trim();
  const isAsync = sig.startsWith("async ");
  const m = sig.match(/->\s*(.+?)(?:\s*:|$)/);
  const returnType = m ? m[1].trim().replace(/:$/, "") : "Any";
  return { isAsync, returnType };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build a context bundle for the custom-query path.
 * Full 5-step retrieval pipeline matching the Python implementation.
 */
export async function buildContextBundleFromQuery(
  userQuery: string,
  workingDir: string,
  synapseDir: string,
  maxCandidates?: number,
  apiKey?: string,
): Promise<ContextBundle> {
  if (maxCandidates == null) maxCandidates = inferMaxCandidates(userQuery);

  const searchTerms = expandQueryForSearch(userQuery);
  const emptyBundle: ContextBundle = {
    endpoints: [],
    project_name: path.basename(workingDir),
    mode: "custom_prompt",
    query: userQuery,
  };

  // Step 1: Grep-based search across expanded terms
  const { searchCodebaseContext } = await import("./context-search.js");
  const seenKeys = new Set<string>();
  const rawChunks: RankedChunk[] = [];

  const searchResults = await searchCodebaseContext(userQuery, workingDir, 20);
  for (const chunk of searchResults.context_snippets) {
    const key = `${chunk.file ?? ""}::${chunk.name ?? ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    let mtime = 0;
    try {
      const absPath = path.isAbsolute(chunk.file) ? chunk.file : path.join(workingDir, chunk.file);
      mtime = fs.statSync(absPath).mtimeMs / 1000;
    } catch { /* skip */ }

    rawChunks.push({
      name: chunk.name ?? "",
      file_path: chunk.file ?? "",
      signature: chunk.signature ?? "",
      docstring: "",
      code: chunk.content ?? "",
      type: chunk.type ?? "function",
      start_line: chunk.start_line ?? 0,
      end_line: chunk.end_line ?? 0,
      score: chunk.score ?? 0,
      mtime,
    });
  }

  // Step 2: Ripgrep exact keyword search
  const kwTerms = searchTerms.slice(1).filter((t) => t.length > 3).slice(0, 5);
  if (kwTerms.length > 0) {
    const grepHits = ripgrepSearch(kwTerms, workingDir, 20);
    for (const hit of grepHits) {
      const key = `${hit.file_path}::${hit.name}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        rawChunks.push(hit);
      }
    }
  }

  if (rawChunks.length === 0) return emptyBundle;

  // Step 3: Public export scan
  let exportedNames: Set<string>;
  try {
    exportedNames = scanPublicExports(workingDir);
  } catch {
    exportedNames = new Set();
  }

  // Step 4: Recency-blended re-ranking
  const ranked = blendAndRank(rawChunks, exportedNames);
  const poolSize = Math.max(maxCandidates * 3, 10);
  const pool = ranked.slice(0, poolSize);

  // Step 5: LLM side-call candidate selection
  const resolvedApiKey = apiKey ?? "";
  const finalChunks = await llmSelectCandidates(
    userQuery, pool, resolvedApiKey, maxCandidates,
  );

  // Build EndpointLike proxies for buildContextBundle
  const endpoints: EndpointLike[] = [];
  for (const chunk of finalChunks) {
    if (!chunk.file_path || !chunk.name) continue;
    const { returnType } = parseSignatureMetadata(chunk.signature);
    endpoints.push({
      name: chunk.name,
      file_path: chunk.file_path,
      signature: chunk.signature || `def ${chunk.name}(...)`,
      docstring: chunk.docstring ?? "",
      return_type: returnType,
      conversion_type: "ready",
      client_dependency: null,
    });
  }

  if (endpoints.length === 0) return emptyBundle;

  const bundle = buildContextBundle(endpoints, workingDir, synapseDir);
  bundle.mode = "custom_prompt";
  bundle.query = userQuery;
  return bundle;
}
