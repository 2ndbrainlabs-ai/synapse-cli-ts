// src/session/session-id.ts
//
// Session identifier + repo fingerprint helpers.
//
// A session lives in .synapse/discover/<session-id>.jsonl. Its id encodes:
//   - an 8-hex tag of the repo hash (git HEAD SHA when available, else
//     SHA-256 of the absolute repo path), keyed with the telemetry salt so
//     it can't be traced back to the repo (SYN-367) — so discover jobs
//     across branches / commits don't collide,
//   - a base-36 wall-clock stamp for chronological sort,
//   - a random suffix, so concurrent runs in the same repo started in the
//     same millisecond never share an id (and a ledger file) — SYN-321.

import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { telemetryHash } from "../utils/telemetry-hash.js";

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

/** Readable prefix for humans: sess_<8-hex>_<ts36>_<rand6>. The id is used
 *  as-is for the ledger file name, so it must stay filename-safe.
 *
 *  The 8-hex repo tag is keyed with the per-install telemetry salt (SYN-367):
 *  the id is sent with telemetry events, and a plain prefix of the repo hash
 *  would leak sha256 of the repo path (or of the git HEAD SHA). Runs on the
 *  same repo and machine still share the tag. Resume matches on the ledger's
 *  repo_hash, not on this tag. */
export function newSessionId(repoHash: string): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(3).toString("hex");
  return `sess_${telemetryHash(repoHash).slice(0, 8)}_${ts}_${rand}`;
}
