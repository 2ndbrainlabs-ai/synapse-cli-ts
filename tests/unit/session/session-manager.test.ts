import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../../src/session/session-manager.js";

describe("SessionManager Ctrl-C handling", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function make(): SessionManager {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-sm-"));
    dirs.push(dir);
    return new SessionManager({
      workingDir: dir,
      sessionId: "sess_test",
      mode: "custom",
      repoHash: "abc",
      cliVersion: "0.0.0",
    });
  }

  it("pauses the session on Ctrl-C while it owns SIGINT", () => {
    const before = process.listenerCount("SIGINT");
    const s = make();
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    process.emit("SIGINT");
    expect(s.aborted).toBe(true);
    s.dispose();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("ignores Ctrl-C after releaseSigint", () => {
    const before = process.listenerCount("SIGINT");
    const s = make();
    s.releaseSigint();
    expect(process.listenerCount("SIGINT")).toBe(before);
    s.dispose();
    expect(s.aborted).toBe(false);
  });
});
