/**
 * Codebase context search — semantic + grep fallback.
 *
 * Ported from Python utils/context_search.py.
 * Used by the build command for query validation and by the
 * tool executor for codebase_context_search tool calls.
 */

import path from "node:path";

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
  search_type: "semantic" | "grep";
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
// Semantic search (primary path)
// ---------------------------------------------------------------------------

export async function searchCodebaseContext(
  query: string,
  workingDir: string,
  maxResults: number = 5,
  _maxDepth: number = 3,
  _includePattern?: string,
  _excludePattern?: string,
): Promise<ContextSearchResult> {
  const synapseDir = path.join(workingDir, ".synapse");

  try {
    const { searchCode } = await import("../indexer/code-indexer.js");
    const semanticResults = await searchCode(query, synapseDir, "code_context", maxResults);

    if (semanticResults && semanticResults.length > 0) {
      const contextSnippets: ContextSnippet[] = [];
      const functionSignatures: ContextSnippet[] = [];
      const relatedFiles = new Set<string>();

      for (const result of semanticResults) {
        relatedFiles.add(result.filePath);

        const snippet: ContextSnippet = {
          file: result.filePath,
          content: result.code,
          type: result.type,
          name: result.name,
          signature: result.signature,
          start_line: result.startLine,
          end_line: result.endLine,
          line_number: result.startLine,
          score: result.score ?? 0,
        };

        contextSnippets.push(snippet);

        if (result.type === "function" || result.type === "class") {
          functionSignatures.push(snippet);
        }
      }

      return {
        context_snippets: contextSnippets,
        function_signatures: functionSignatures,
        related_files: [...relatedFiles],
        import_chain: [],
        query,
        total_results: contextSnippets.length,
        search_type: "semantic",
      };
    }
  } catch {
    // Fall through to grep-based search
  }

  return grepBasedSearch(query, workingDir, maxResults);
}

// ---------------------------------------------------------------------------
// Grep-based fallback
// ---------------------------------------------------------------------------

async function grepBasedSearch(
  query: string,
  workingDir: string,
  maxResults: number,
): Promise<ContextSearchResult> {
  try {
    const { grepSearch } = await import("../tools/search-ops.js");

    const [results, success] = grepSearch(query, {
      caseSensitive: false,
      includePattern: "*.py",
      workingDir,
    });

    if (!success || results.length === 0) {
      return {
        context_snippets: [],
        function_signatures: [],
        related_files: [],
        import_chain: [],
        query,
        total_results: 0,
        search_type: "grep",
      };
    }

    const contextSnippets: ContextSnippet[] = [];
    const relatedFiles = new Set<string>();

    for (const result of results.slice(0, maxResults)) {
      relatedFiles.add(result.file);
      contextSnippets.push({
        file: result.file,
        content: result.content,
        type: "unknown",
        name: "",
        signature: "",
        start_line: result.lineNumber,
        end_line: result.lineNumber,
        line_number: result.lineNumber,
        score: calculateRelevance(query, result.content),
      });
    }

    return {
      context_snippets: contextSnippets,
      function_signatures: [],
      related_files: [...relatedFiles],
      import_chain: [],
      query,
      total_results: contextSnippets.length,
      search_type: "grep",
    };
  } catch {
    return {
      context_snippets: [],
      function_signatures: [],
      related_files: [],
      import_chain: [],
      query,
      total_results: 0,
      search_type: "grep",
      error: "Grep search failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

/**
 * Validate if the user query has sufficient context in the codebase.
 * Returns "valid" (3+), "insufficient" (0), or "uncertain" (1-2) high-quality results.
 */
export async function validateQueryRelevance(
  query: string,
  workingDir: string,
  minGoodResults: number = 1,
  minScore: number = 0.20,
): Promise<ValidationResult> {
  try {
    const results = await searchCodebaseContext(query, workingDir, 5);
    const totalResults = results.total_results;
    const displayResults = results.function_signatures.length > 0
      ? results.function_signatures
      : results.context_snippets;

    const highQuality = displayResults.filter((r) => r.score >= minScore);
    const highQualityCount = highQuality.length;
    const bestScore = Math.max(...displayResults.map((r) => r.score), 0);

    if (highQualityCount >= minGoodResults) {
      return {
        status: "valid",
        total_results: totalResults,
        high_quality_results: highQualityCount,
        results: highQuality,
        message: `Found ${highQualityCount} relevant code elements for your query`,
        query,
        best_score: bestScore,
      };
    }

    if (highQualityCount === 0) {
      const message = totalResults === 0
        ? "No functions, classes, or code patterns match this query."
        : "No relevant code found. The codebase may not have functionality related to your query.";
      return {
        status: "insufficient",
        total_results: totalResults,
        high_quality_results: 0,
        results: displayResults.slice(0, 3),
        message,
        query,
        best_score: bestScore,
      };
    }

    return {
      status: "uncertain",
      total_results: totalResults,
      high_quality_results: highQualityCount,
      results: highQuality,
      message: `Found ${highQualityCount} potentially relevant element(s)`,
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
// Available components listing
// ---------------------------------------------------------------------------

export async function getAvailableComponents(
  workingDir: string,
  maxItems: number = 20,
): Promise<AvailableComponents> {
  const synapseDir = path.join(workingDir, ".synapse");

  try {
    const { getAllIndexedItems } = await import("../indexer/code-indexer.js");
    const allItems = await getAllIndexedItems(synapseDir, "code_context", 100);

    const functions: AvailableComponents["functions"] = [];
    const classes: AvailableComponents["classes"] = [];

    for (const item of allItems) {
      let filePath = item.filePath ?? "";
      if (filePath.startsWith(workingDir)) {
        filePath = path.relative(workingDir, filePath);
      }

      const component = {
        name: item.name ?? "",
        signature: item.signature ?? "",
        file: filePath,
        line: item.startLine ?? 0,
      };

      if (item.type === "function") functions.push(component);
      else if (item.type === "class") classes.push(component);
    }

    functions.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    classes.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    return {
      functions: functions.slice(0, maxItems),
      classes: classes.slice(0, maxItems),
      total_count: allItems.length,
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

  output.push(`Context Search Results for: ${results.query}`);
  output.push(`Search Type: ${results.search_type}`);
  output.push("=".repeat(80));
  output.push("");

  if (results.function_signatures.length > 0) {
    output.push(`Relevant Code (${results.function_signatures.length}):`);
    output.push("-".repeat(80));
    for (const sig of results.function_signatures.slice(0, 10)) {
      output.push(`  File: ${sig.file}`);
      output.push(`  Line: ${sig.line_number}`);
      output.push(`  Type: ${sig.type}`);
      if (sig.score) output.push(`  Relevance: ${sig.score.toFixed(3)}`);
      output.push(`  Signature: ${sig.signature}`);
      if (sig.content) {
        output.push("  Code:");
        const lines = sig.content.split("\n").slice(0, 20);
        for (const line of lines) output.push(`    ${line}`);
        if (sig.content.split("\n").length > 20) output.push("    ... (truncated)");
      }
      output.push("");
    }
  } else if (results.context_snippets.length > 0) {
    output.push(`Code Context (${results.context_snippets.length}):`);
    output.push("-".repeat(80));
    for (const snippet of results.context_snippets.slice(0, 10)) {
      output.push(`  File: ${snippet.file}`);
      output.push(`  Line: ${snippet.line_number}`);
      if (snippet.type) output.push(`  Type: ${snippet.type}`);
      if (snippet.name) output.push(`  Name: ${snippet.name}`);
      output.push(`  Content: ${snippet.content.slice(0, 200)}...`);
      output.push("");
    }
  }

  if (results.related_files.length > 0) {
    output.push(`Related Files (${results.related_files.length}):`);
    output.push("-".repeat(80));
    for (const fp of results.related_files.slice(0, 20)) {
      output.push(`  ${fp}`);
    }
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
