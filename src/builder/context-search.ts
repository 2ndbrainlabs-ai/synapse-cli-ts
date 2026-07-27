/**
 * Codebase context search — grep + tree-sitter (no vector DB).
 *
 * Uses keyword search to find relevant code, then tree-sitter to extract
 * the containing function/class for each match. This is the same approach
 * Claude Code uses: ripgrep for finding, AST for understanding.
 */

import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextSnippet {
  file: string;
  content: string;
  type: string;
  name: string;
  signature: string;
  start_line: number;
  end_line: number;
  line_number: number;
  score: number;
}

export interface ContextSearchResult {
  context_snippets: ContextSnippet[];
  function_signatures: ContextSnippet[];
  related_files: string[];
  import_chain: string[];
  query: string;
  total_results: number;
  search_type: "grep";
  error?: string;
}

export interface ValidationResult {
  status: "valid" | "insufficient" | "uncertain";
  total_results: number;
  high_quality_results: number;
  results: ContextSnippet[];
  message: string;
  query: string;
  best_score?: number;
  error?: string;
}

export interface AvailableComponents {
  functions: Array<{ name: string; signature: string; file: string; line: number }>;
  classes: Array<{ name: string; signature: string; file: string; line: number }>;
  total_count: number;
  functions_total: number;
  classes_total: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Main search: grep + tree-sitter function extraction
// ---------------------------------------------------------------------------

export async function searchCodebaseContext(
  query: string,
  workingDir: string,
  maxResults: number = 10,
  _maxDepth?: number,
  _includePattern?: string,
  _excludePattern?: string,
): Promise<ContextSearchResult> {
  const { grepSearch } = await import("../tools/grep-search.js");

  // Expand query into multiple search terms
  const searchTerms = expandQuery(query);

  const allResults: Map<string, ContextSnippet> = new Map();
  const relatedFiles = new Set<string>();

  // Search for each term
  for (const term of searchTerms.slice(0, 5)) {
    const { matches } = grepSearch(term, workingDir, {
      file_type: "py",
      max_results: 20,
    });

    if (matches.length === 0) continue;

    for (const result of matches) {
      const relPath = result.file;
      relatedFiles.add(relPath);

      // Try to extract the containing function using tree-sitter
      const funcSnippet = await extractContainingFunction(
        path.isAbsolute(result.file) ? result.file : path.join(workingDir, result.file),
        result.line,
      );

      if (funcSnippet) {
        const key = `${funcSnippet.file}:${funcSnippet.name}`;
        if (!allResults.has(key)) {
          funcSnippet.score = calculateRelevance(query, funcSnippet.content);
          allResults.set(key, funcSnippet);
        }
      } else {
        // No function context — use raw grep match
        const key = `${relPath}:${result.line}`;
        if (!allResults.has(key)) {
          allResults.set(key, {
            file: relPath,
            content: result.content,
            type: "code",
            name: "",
            signature: "",
            start_line: result.line,
            end_line: result.line,
            line_number: result.line,
            score: calculateRelevance(query, result.content),
          });
        }
      }
    }
  }

  // Also search for function/class definitions directly
  const defResults = grepSearch(
    `(?:async\\s+)?def\\s+\\w*(?:${escapeForRegex(searchTerms[0])})\\w*\\s*\\(|class\\s+\\w*(?:${escapeForRegex(searchTerms[0])})\\w*`,
    workingDir,
    { file_type: "py", max_results: 10 },
  );

  if (defResults.matches.length > 0) {
    for (const result of defResults.matches) {
      const relPath = result.file;
      relatedFiles.add(relPath);

      const funcSnippet = await extractContainingFunction(
        path.isAbsolute(result.file) ? result.file : path.join(workingDir, result.file),
        result.line,
      );
      if (funcSnippet) {
        const key = `${funcSnippet.file}:${funcSnippet.name}`;
        if (!allResults.has(key)) {
          funcSnippet.score = calculateRelevance(query, funcSnippet.content) + 0.2; // Boost definitions
          allResults.set(key, funcSnippet);
        }
      }
    }
  }

  // Sort by score, take top N
  const sorted = [...allResults.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
  const functionSnippets = sorted.filter((s) => s.type === "function" || s.type === "class");

  return {
    context_snippets: sorted,
    function_signatures: functionSnippets,
    related_files: [...relatedFiles].slice(0, 20),
    import_chain: [],
    query,
    total_results: sorted.length,
    search_type: "grep",
  };
}

// ---------------------------------------------------------------------------
// Tree-sitter function extraction
// ---------------------------------------------------------------------------

async function extractContainingFunction(
  absFilePath: string,
  lineNumber: number,
): Promise<ContextSnippet | null> {
  try {
    if (!fs.existsSync(absFilePath)) return null;
    const source = fs.readFileSync(absFilePath, "utf-8");
    const lines = source.split("\n");

    // Walk backwards from the match line to find the enclosing def/class
    let funcStartLine = -1;
    let funcName = "";
    let funcType = "function";
    let indentLevel = -1;

    for (let i = lineNumber - 1; i >= 0; i--) {
      const line = lines[i];
      const defMatch = line.match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(/);
      const classMatch = line.match(/^(\s*)class\s+(\w+)/);

      if (defMatch) {
        const thisIndent = defMatch[1].length;
        if (indentLevel === -1 || thisIndent < indentLevel) {
          funcStartLine = i;
          funcName = defMatch[3];
          funcType = "function";
          indentLevel = thisIndent;
          break;
        }
      } else if (classMatch) {
        const thisIndent = classMatch[1].length;
        if (indentLevel === -1 || thisIndent < indentLevel) {
          funcStartLine = i;
          funcName = classMatch[2];
          funcType = "class";
          indentLevel = thisIndent;
          break;
        }
      }
    }

    if (funcStartLine === -1) return null;

    // Find the end of the function (next line at same or lower indent level)
    let funcEndLine = lines.length - 1;
    for (let i = funcStartLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue; // Skip blank lines
      const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (currentIndent <= indentLevel && line.trim() !== "") {
        funcEndLine = i - 1;
        break;
      }
    }

    // Cap at 50 lines to avoid sending huge functions
    const endLine = Math.min(funcEndLine, funcStartLine + 50);
    const content = lines.slice(funcStartLine, endLine + 1).join("\n");
    const signature = lines[funcStartLine].trim();

    const relPath = absFilePath; // Will be made relative by caller if needed

    return {
      file: relPath,
      content,
      type: funcType,
      name: funcName,
      signature,
      start_line: funcStartLine + 1,
      end_line: endLine + 1,
      line_number: funcStartLine + 1,
      score: 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

export async function validateQueryRelevance(
  query: string,
  workingDir: string,
  minGoodResults: number = 1,
  minScore: number = 0.20,
): Promise<ValidationResult> {
  try {
    const results = await searchCodebaseContext(query, workingDir, 5);
    const displayResults = results.function_signatures.length > 0
      ? results.function_signatures
      : results.context_snippets;

    const highQuality = displayResults.filter((r) => r.score >= minScore);
    const bestScore = Math.max(...displayResults.map((r) => r.score), 0);

    if (highQuality.length >= minGoodResults) {
      return {
        status: "valid",
        total_results: results.total_results,
        high_quality_results: highQuality.length,
        results: highQuality,
        message: `Found ${highQuality.length} relevant code elements`,
        query,
        best_score: bestScore,
      };
    }

    if (highQuality.length === 0) {
      return {
        status: "insufficient",
        total_results: results.total_results,
        high_quality_results: 0,
        results: displayResults.slice(0, 3),
        message: "No relevant code found for your query.",
        query,
        best_score: bestScore,
      };
    }

    return {
      status: "uncertain",
      total_results: results.total_results,
      high_quality_results: highQuality.length,
      results: highQuality,
      message: `Found ${highQuality.length} potentially relevant element(s)`,
      query,
      best_score: bestScore,
    };
  } catch (e) {
    return {
      status: "uncertain",
      total_results: 0,
      high_quality_results: 0,
      results: [],
      message: `Could not validate query: ${e}`,
      query,
      error: String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Available components (grep-based: find all def/class declarations)
// ---------------------------------------------------------------------------

export async function getAvailableComponents(
  workingDir: string,
  maxItems: number = 20,
): Promise<AvailableComponents> {
  try {
    const { grepSearch } = await import("../tools/grep-search.js");

    const functions: AvailableComponents["functions"] = [];
    const classes: AvailableComponents["classes"] = [];

    // Find all function definitions
    const funcResults = grepSearch("^\\s*(async\\s+)?def\\s+\\w+", workingDir, { file_type: "py" });

    for (const r of funcResults.matches) {
      const match = r.content.match(/(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
      if (match && !match[1].startsWith("_")) {
        functions.push({
          name: match[1],
          signature: r.content.trim(),
          file: r.file,
          line: r.line,
        });
      }
    }

    // Find all class definitions
    const classResults = grepSearch("^\\s*class\\s+\\w+", workingDir, { file_type: "py" });

    for (const r of classResults.matches) {
      const match = r.content.match(/class\s+(\w+)/);
      if (match && !match[1].startsWith("_")) {
        classes.push({
          name: match[1],
          signature: r.content.trim(),
          file: r.file,
          line: r.line,
        });
      }
    }

    return {
      functions: functions.slice(0, maxItems),
      classes: classes.slice(0, maxItems),
      total_count: functions.length + classes.length,
      functions_total: functions.length,
      classes_total: classes.length,
    };
  } catch (e) {
    return {
      functions: [],
      classes: [],
      total_count: 0,
      functions_total: 0,
      classes_total: 0,
      error: String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Format context results for tool output
// ---------------------------------------------------------------------------

export function formatContextResults(results: ContextSearchResult): string {
  const output: string[] = [];

  output.push(`Search Results for: "${results.query}"`);
  output.push("=".repeat(60));
  output.push("");

  if (results.function_signatures.length > 0) {
    output.push(`Functions/Classes Found (${results.function_signatures.length}):`);
    output.push("-".repeat(60));
    for (const sig of results.function_signatures.slice(0, 10)) {
      output.push(`  ${sig.name} (${sig.file}:${sig.line_number})`);
      if (sig.content) {
        const lines = sig.content.split("\n").slice(0, 25);
        for (const line of lines) output.push(`    ${line}`);
        if (sig.content.split("\n").length > 25) output.push("    ...");
      }
      output.push("");
    }
  } else if (results.context_snippets.length > 0) {
    output.push(`Code Matches (${results.context_snippets.length}):`);
    output.push("-".repeat(60));
    for (const snippet of results.context_snippets.slice(0, 10)) {
      output.push(`  ${snippet.file}:${snippet.line_number}`);
      output.push(`    ${snippet.content.slice(0, 200)}`);
      output.push("");
    }
  } else {
    output.push("No results found.");
  }

  if (results.related_files.length > 0) {
    output.push("");
    output.push(`Related Files: ${results.related_files.slice(0, 10).join(", ")}`);
  }

  return output.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calculateRelevance(query: string, text: string): number {
  if (!text) return 0;
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  if (textLower.includes(queryLower)) return 1.0;

  const queryWords = new Set(queryLower.match(/\b[a-z_]\w*\b/g) ?? []);
  const textWords = new Set(textLower.match(/\b[a-z_]\w*\b/g) ?? []);
  if (queryWords.size === 0) return 0;

  let matches = 0;
  for (const w of queryWords) {
    if (textWords.has(w)) matches++;
  }
  return matches / queryWords.size;
}

function expandQuery(query: string): string[] {
  const words = query.toLowerCase().match(/\b[a-z_]\w{2,}\b/g) ?? [];
  const filtered = words.filter((w) => !STOPWORDS.has(w));

  // Primary: full query as-is (for multi-word matches)
  const terms = [query];

  // Individual meaningful terms
  for (const word of filtered.slice(0, 5)) {
    if (!terms.includes(word)) terms.push(word);
  }

  return terms;
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "that", "this", "these",
  "those", "and", "but", "or", "nor", "for", "yet", "so", "from",
  "with", "about", "into", "through", "during", "before", "after",
  "above", "below", "between", "just", "only", "very", "also", "like",
  "want", "need", "create", "make", "build", "use", "get", "set",
  "tool", "function", "method", "class",
]);
