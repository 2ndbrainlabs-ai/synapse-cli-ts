import fs from "node:fs";
import path from "node:path";

/**
 * Write or insert content into a file.
 *
 * - If `lineNumber` is undefined/null the entire file is replaced (or created).
 * - If `lineNumber` is specified the content is inserted at that 1-based
 *   position. When the position is beyond the current end of the file the gap
 *   is padded with empty lines.
 *
 * Directories are created as needed.
 *
 * @param targetFile - Path to the file to modify or create
 * @param content - The content to write / insert
 * @param lineNumber - 1-based insertion point (omit to replace the whole file)
 * @returns Tuple of [message, success]
 */
export function insertFile(
  targetFile: string,
  content: string,
  lineNumber?: number,
): [string, boolean] {
  try {
    const resolved = path.resolve(targetFile);

    // Ensure parent directories exist
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    const fileExists = fs.existsSync(resolved);

    // --- Full-file replacement / creation ---
    if (lineNumber == null) {
      if (fileExists) {
        fs.unlinkSync(resolved);
      }

      fs.writeFileSync(resolved, content, "utf-8");

      const operation = fileExists ? "replaced" : "created";
      return [`Successfully ${operation} ${targetFile}`, true];
    }

    // --- Insertion at a specific line ---
    if (lineNumber < 1) {
      return ["Error: Line number must be at least 1", false];
    }

    let lines: string[];
    let operation: string;

    if (!fileExists) {
      // File does not exist yet -- create an array of empty lines up to the
      // insertion point so the content lands at the requested position.
      lines = new Array<string>(Math.max(0, lineNumber - 1)).fill("");
      operation = "created and inserted into";
    } else {
      const text = fs.readFileSync(resolved, "utf-8");
      lines = text.split("\n");
      operation = "inserted into";
    }

    const position = lineNumber - 1; // 0-based

    // Pad with empty lines if the position is beyond current content
    while (lines.length < position) {
      lines.push("");
    }

    // Split the incoming content into individual lines
    const newLines = content.split("\n");

    if (position === lines.length) {
      // Appending at the end -- ensure the previous last line ends properly
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        // The previous last element is non-empty; that is fine, just push.
      }
      lines.push(...newLines);
    } else {
      lines.splice(position, 0, ...newLines);
    }

    fs.writeFileSync(resolved, lines.join("\n"), "utf-8");

    return [
      `Successfully ${operation} ${targetFile} at line ${lineNumber}`,
      true,
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`Error inserting file: ${msg}`, false];
  }
}
