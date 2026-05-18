import fs from "node:fs";
import path from "node:path";

/**
 * Write content to a file, creating directories as needed.
 * Reports whether the file was created or updated.
 *
 * @param targetFile - Path to the file to write
 * @param content - The content to write
 * @returns Object with a human-readable message
 */
export function writeFile(
  targetFile: string,
  content: string,
): { message: string } {
  const resolved = path.resolve(targetFile);

  // Ensure parent directories exist
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const existed = fs.existsSync(resolved);

  fs.writeFileSync(resolved, content, "utf-8");

  const operation = existed ? "updated" : "created";
  return { message: `Successfully ${operation} ${targetFile}` };
}
