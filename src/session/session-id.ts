// src/session/session-id.ts
//
// Session identifier + repo fingerprint helpers.
//
// A session lives in .synapse/discover/<session-id>.jsonl. Its id encodes:
//   - the first 8 hex chars of the repo hash (git HEAD SHA when available,
//     else SHA-256 of the absolute repo path) — so discover jobs across
//     branches / commits don't collide,
//   - a base-36 wall-clock stamp for chronological sort.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Cheap fingerprint of the target repo. Prefers `git rev-parse HEAD` so a
 *  new commit invalidates prior sessions cleanly; falls back to the absolute
 *  path SHA when git isn't present. */
export function computeRepoHash(workingDir: string): string {
  try {
    const head = execSync("git rev-parse HEAD", {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    if (head) return createHash("sha256").update(head).digest("hex");
  } catch {
    // Not a git repo — fall through.
  }
  return createHash("sha256").update(workingDir).digest("hex");
}

/** Deterministic prefix for humans: sess_<first-8-hex>_<ts36>. */
export function newSessionId(repoHash: string): string {
  const ts = Date.now().toString(36);
  return `sess_${repoHash.slice(0, 8)}_${ts}`;
}
