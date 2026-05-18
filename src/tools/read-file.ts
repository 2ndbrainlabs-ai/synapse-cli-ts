import fs from "node:fs";
import path from "node:path";

/**
 * Read content from a file with optional line range support.
 * Prepends 1-based line numbers to each line in the output.
 *
 * @param targetFile - Path to the file (relative or absolute)
 * @param startLine - Starting line number (1-based, inclusive)
 * @param endLine - Ending line number (1-based, inclusive)
 * @returns Tuple of [content with line numbers, success]
 */
export function readFile(
  targetFile: string,
  startLine?: number,
  endLine?: number,
): [string, boolean] {
  try {
    const resolved = path.resolve(targetFile);

    if (!fs.existsSync(resolved)) {
      return [`Error: File ${targetFile} does not exist`, false];
    }

    const text = fs.readFileSync(resolved, "utf-8");
    const lines = text.split("\n");

    // If the file ends with a newline the split produces a trailing empty
    // string; keep it so line counts stay consistent with the Python version
    // which uses readlines() (each element retains its trailing \n).

    // If either bound is missing, read the entire file
    if (startLine == null || endLine == null) {
      const numbered = lines.map((l, i) => `${i + 1}: ${l}`);
      return [numbered.join("\n"), true];
    }

    // Validate line range
    if (startLine < 1) {
      return ["Error: start_line_one_indexed must be at least 1", false];
    }

    if (endLine < startLine) {
      return [
        "Error: end_line_one_indexed_inclusive must be >= start_line_one_indexed",
        false,
      ];
    }

    const span = endLine - startLine + 1;
    if (span > 250) {
      return ["Error: Cannot read more than 250 lines at once", false];
    }

    // Convert to 0-based indices
    const startIdx = startLine - 1;

    if (startIdx >= lines.length) {
      return [
        `Error: start_line_one_indexed (${startLine}) exceeds file length (${lines.length})`,
        false,
      ];
    }

    const endIdx = Math.min(endLine - 1, lines.length - 1);

    const numbered = lines
      .slice(startIdx, endIdx + 1)
      .map((l, i) => `${startIdx + i + 1}: ${l}`);

    return [numbered.join("\n"), true];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`Error reading file: ${msg}`, false];
  }
}
