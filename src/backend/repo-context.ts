// src/backend/repo-context.ts
//
// Cheap, deterministic README/docs discovery — gives the endpoint namer
// (local and hosted) domain framing beyond a single handler's source, e.g.
// "this is a claims-processing API for insurance adjusters" from the repo's
// own README, when the handler code alone wouldn't say that.
//
// No LLM, no AST — just reads a small, fixed set of well-known files and
// truncates hard. Shared by local (endpoint-namer.ts) and hosted (sent to
// the backend as NameEndpointsRequest.readme_context) naming paths.

import fs from "node:fs";
import path from "node:path";

const CANDIDATE_FILES = [
  "README.md",
  "README.rst",
  "README.txt",
  "README",
  "docs/README.md",
  "docs/index.md",
  "docs/overview.md",
];

const MAX_CONTEXT_CHARS = 6000;
const MAX_PER_FILE_CHARS = 3000;

/** Reads the first few well-known README/docs files, concatenated and hard-truncated. */
export function readRepoContext(workingDir: string): string {
  const chunks: string[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const rel of CANDIDATE_FILES) {
    if (budget <= 0) break;
    const abs = path.join(workingDir, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const clipped = trimmed.slice(0, Math.min(MAX_PER_FILE_CHARS, budget));
    chunks.push(`# ${rel}\n${clipped}`);
    budget -= clipped.length;
  }

  return chunks.join("\n\n---\n\n");
}
