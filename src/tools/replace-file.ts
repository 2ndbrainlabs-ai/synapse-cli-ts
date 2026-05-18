import fs from "node:fs";
import path from "node:path";

/**
 * Replace lines in a file between startLine and endLine (inclusive, 1-based)
 * with new content.
 *
 * Internally this removes the target lines and inserts the replacement at the
 * same position, matching the Python implementation which delegates to
 * remove_file + insert_file.
 *
 * @param targetFile - Path to the file to modify
 * @param startLine - First line to replace (1-based)
 * @param endLine - Last line to replace (1-based, inclusive)
 * @param content - Replacement content (may span a different number of lines)
 * @returns Tuple of [message, success]
 */
export function replaceFile(
  targetFile: string,
  startLine: number,
  endLine: number,
  content: string,
): [string, boolean] {
  try {
    const resolved = path.resolve(targetFile);

    if (!fs.existsSync(resolved)) {
      return [`Error: File ${targetFile} does not exist`, false];
    }

    if (startLine < 1) {
      return ["Error: start_line must be at least 1", false];
    }

    if (endLine < 1) {
      return ["Error: end_line must be at least 1", false];
    }

    if (startLine > endLine) {
      return [
        "Error: start_line must be less than or equal to end_line",
        false,
      ];
    }

    const text = fs.readFileSync(resolved, "utf-8");
    const lines = text.split("\n");

    // Convert to 0-based
    const startIdx = startLine - 1;
    const endIdx = Math.min(endLine - 1, lines.length - 1);

    if (startIdx >= lines.length) {
      return [
        `Error: start_line (${startLine}) exceeds file length (${lines.length})`,
        false,
      ];
    }

    // Remove the target range
    lines.splice(startIdx, endIdx - startIdx + 1);

    // Split the replacement content into lines. If the content ends with a
    // newline we get a trailing empty string from split; that mirrors how
    // the Python version (writelines) would behave when the inserted text
    // ends in \n.
    const newLines = content.split("\n");

    // Insert new content at the same position
    lines.splice(startIdx, 0, ...newLines);

    fs.writeFileSync(resolved, lines.join("\n"), "utf-8");

    return [
      `Successfully replaced lines ${startLine} to ${endLine} in ${targetFile}`,
      true,
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`Error replacing content: ${msg}`, false];
  }
}
