// Session ids are unique per run, even for concurrent runs in one repo
// (SYN-321). Before, the id was sess_<repoHash8>_<ts36> only, so parallel
// builds started in the same millisecond shared one id and one ledger file.

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { newSessionId } from "../../../src/session/session-id.js";
import { Ledger, findResumable, getLedgerPath } from "../../../src/session/ledger.js";

const REPO_HASH = "368b26fc".padEnd(64, "0");

describe("newSessionId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the readable sess_<hash8>_<ts36> prefix and adds a random suffix", () => {
    const id = newSessionId(REPO_HASH);
    expect(id).toMatch(/^sess_368b26fc_[0-9a-z]+_[0-9a-f]{6}$/);
  });

  it("gives distinct ids to runs started in the same millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_761_580_320_000);
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId(REPO_HASH)));
    expect(ids.size).toBe(50);
  });

  it("stays filename-safe, so each run gets its own ledger file", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_761_580_320_000);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-sess-"));
    try {
      const ids = [newSessionId(REPO_HASH), newSessionId(REPO_HASH), newSessionId(REPO_HASH)];
      for (const id of ids) {
        new Ledger(project, id).append({
          type: "session_open",
          session_id: id,
          mode: "custom",
          repo_hash: REPO_HASH,
          working_dir: project,
          cli_version: "0.0.0",
          started_at: 0,
          deadline_at: 0,
        });
      }
      const files = fs.readdirSync(path.join(project, ".synapse", "discover"));
      expect(files.sort()).toEqual(ids.map((id) => `${id}.jsonl`).sort());
      for (const id of ids) expect(fs.existsSync(getLedgerPath(project, id))).toBe(true);
      // The file name round-trips back to the id for resume / logs.
      expect(findResumable(project, REPO_HASH).map((s) => s.sessionId).sort()).toEqual(
        [...ids].sort(),
      );
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
