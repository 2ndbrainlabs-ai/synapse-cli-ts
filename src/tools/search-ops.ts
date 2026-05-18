import fs from "node:fs";
import path from "node:path";

/** A single grep match. */
export interface GrepResult {
  file: string;
  lineNumber: number;
  content: string;
}

export interface GrepSearchOptions {
  caseSensitive?: boolean;
  includePattern?: string;
  excludePattern?: string;
  workingDir?: string;
}

const MAX_RESULTS = 50;

/**
 * Search through files for a regex pattern, walking the directory tree.
 *
 * @param query - Regular expression pattern to search for
 * @param opts - Search options (case sensitivity, glob include/exclude, dir)
 * @returns Tuple of [results array, success]
 */
export function grepSearch(
  query: string,
  opts: GrepSearchOptions = {},
): [GrepResult[], boolean] {
  const {
    caseSensitive = true,
    includePattern,
    excludePattern,
    workingDir,
  } = opts;

  const searchDir = workingDir ? path.resolve(workingDir) : process.cwd();

  const results: GrepResult[] = [];

  // Compile the search regex
  let pattern: RegExp;
  try {
    pattern = new RegExp(query, caseSensitive ? "" : "i");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid regex pattern: ${msg}`);
    return [[], false];
  }

  // Convert glob patterns to RegExp arrays
  const includeRegexes = includePattern
    ? globToRegex(includePattern)
    : undefined;
  const excludeRegexes = excludePattern
    ? globToRegex(excludePattern)
    : undefined;

  try {
    walkDir(searchDir, results, pattern, includeRegexes, excludeRegexes);
    return [results, true];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Search error: ${msg}`);
    return [[], false];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory, searching each matching file line by line.
 * Stops early once MAX_RESULTS matches have been collected.
 */
function walkDir(
  dir: string,
  results: GrepResult[],
  pattern: RegExp,
  includeRegexes: RegExp[] | undefined,
  excludeRegexes: RegExp[] | undefined,
): void {
  if (results.length >= MAX_RESULTS) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Permission denied or similar -- skip
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip common non-content directories
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "__pycache__"
      ) {
        continue;
      }
      walkDir(fullPath, results, pattern, includeRegexes, excludeRegexes);
    } else if (entry.isFile()) {
      // Apply include filter
      if (includeRegexes && includeRegexes.length > 0) {
        if (!includeRegexes.some((r) => r.test(entry.name))) continue;
      }

      // Apply exclude filter
      if (excludeRegexes && excludeRegexes.length > 0) {
        if (excludeRegexes.some((r) => r.test(entry.name))) continue;
      }

      searchFile(fullPath, results, pattern);
    }
  }
}

/**
 * Search a single file line-by-line and append matches to results.
 */
function searchFile(
  filePath: string,
  results: GrepResult[],
  pattern: RegExp,
): void {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    // Binary file or unreadable -- skip
    return;
  }

  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (results.length >= MAX_RESULTS) return;

    if (pattern.test(lines[i])) {
      results.push({
        file: filePath,
        lineNumber: i + 1,
        content: lines[i].trimEnd(),
      });
    }
  }
}

/**
 * Convert a comma-separated glob pattern string into an array of RegExp
 * objects for matching filenames.
 *
 * Supported glob metacharacters: `*` (any chars), `?` (single char), `.`
 * (literal dot).
 */
function globToRegex(patternStr: string): RegExp[] {
  const regexes: RegExp[] = [];

  for (let glob of patternStr.split(",")) {
    glob = glob.trim();
    if (!glob) continue;

    const regex = glob
      .replace(/\./g, "\\.")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");

    try {
      regexes.push(new RegExp(`^${regex}$`));
    } catch {
      // Skip invalid patterns
    }
  }

  return regexes;
}
