import fs from "node:fs";
import path from "node:path";

export function loadIndexMetadata(synapseDir: string): Record<string, number> {
  const directPath = path.join(synapseDir, "index_metadata.json");
  if (!fs.existsSync(directPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(directPath, "utf-8"));
  } catch {
    return {};
  }
}

export function saveIndexMetadata(synapseDir: string, metadata: Record<string, number>): void {
  const directPath = path.join(synapseDir, "index_metadata.json");
  fs.writeFileSync(directPath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function initializeIndexMetadata(
  rootDir: string,
  synapseDir: string,
  skipPatterns?: Set<string>,
  skipDirs?: Set<string>,
): void {
  // Record current mtime for all indexable files (called after full index)
  if (!skipPatterns) skipPatterns = new Set(["mcp_server.py"]);
  if (!skipDirs) skipDirs = new Set([
    "__pycache__", ".git", ".venv", "venv", "node_modules",
    ".synapse", "env", ".env",
  ]);

  const metadata: Record<string, number> = {};

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs!.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        if (skipPatterns!.has(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        try {
          metadata[filePath] = fs.statSync(filePath).mtimeMs / 1000;
        } catch {
          /* skip unreadable files */
        }
      }
    }
  }

  walk(rootDir);
  saveIndexMetadata(synapseDir, metadata);
}
