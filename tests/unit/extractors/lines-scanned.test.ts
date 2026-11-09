// v2 extractors expose the lines they scanned on the manifest (SYN-315).

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractPythonSurfaceStreamed } from "../../../src/extractors/languages/python-streamed.js";
import { extractTypescriptSurfaceStreamed } from "../../../src/extractors/languages/typescript-streamed.js";
import type { SessionManager } from "../../../src/session/session-manager.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("lines_scanned", () => {
  it("sums the lines of the files a streamed extractor parsed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-lines-ts-"));
    dirs.push(dir);
    const route = 'import express from "express";\nconst app = express();\napp.get("/a", (req, res) => res.send("ok"));\n';
    fs.writeFileSync(path.join(dir, "a.ts"), route + "// pad\n".repeat(7)); // 10 lines
    fs.writeFileSync(path.join(dir, "b.ts"), route + "// pad"); // 4 lines, no trailing newline
    fs.writeFileSync(path.join(dir, "util.ts"), "export const x = 1;\n"); // no route needle: not parsed

    const session = {
      signal: new AbortController().signal,
      resume: { scanned: new Map() },
      append: () => {},
    } as unknown as SessionManager;
    const manifest = await extractTypescriptSurfaceStreamed({ workingDir: dir, session });

    expect(manifest.endpoints.length).toBeGreaterThan(0);
    expect(manifest.lines_scanned).toBe(14);
  });

  it("counts unchanged TypeScript files replayed from the discovery cache (SYN-8)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-lines-ts-cache-"));
    dirs.push(dir);
    const route = 'import express from "express";\nconst app = express();\napp.get("/a", (req, res) => res.send("ok"));\n';
    fs.writeFileSync(path.join(dir, "a.ts"), route); // 3 lines, parsed
    fs.writeFileSync(path.join(dir, "cached.ts"), route + "// pad\n".repeat(5)); // 8 lines, replayed

    const cachedSha = createHash("sha256")
      .update(fs.readFileSync(path.join(dir, "cached.ts")))
      .digest("hex");
    const appended: unknown[] = [];
    const session = {
      signal: new AbortController().signal,
      resume: {
        scanned: new Map([["cached.ts", { sha: cachedSha, endpoints: [], functions: [] }]]),
      },
      append: (r: unknown) => appended.push(r),
    } as unknown as SessionManager;

    const manifest = await extractTypescriptSurfaceStreamed({ workingDir: dir, session });

    expect(manifest.lines_scanned).toBe(11);
    // Only the changed file is parsed (and checkpointed).
    expect(appended).toHaveLength(1);
  });

  it("counts unchanged files replayed from the ledger, so a resume reports the same total", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-lines-py-"));
    dirs.push(dir);
    const src = '@app.get("/a")\ndef a():\n    return 1\n';
    fs.writeFileSync(path.join(dir, "routes.py"), src); // 3 lines
    fs.writeFileSync(path.join(dir, "cached.py"), src + "# pad\n".repeat(5)); // 8 lines

    const cachedSha = createHash("sha256")
      .update(fs.readFileSync(path.join(dir, "cached.py")))
      .digest("hex");
    const session = {
      signal: new AbortController().signal,
      aborted: false,
      resume: {
        scanned: new Map([["cached.py", { sha: cachedSha, endpoints: [], functions: [] }]]),
      },
      bumpProgress: () => {},
      append: () => {},
      markDone: () => {},
    } as unknown as SessionManager;

    const prev = process.env.SYNAPSE_DISABLE_WORKERS;
    process.env.SYNAPSE_DISABLE_WORKERS = "1";
    try {
      const manifest = await extractPythonSurfaceStreamed({ workingDir: dir, session });
      expect(manifest.stats.filesSkippedUnchanged).toBe(1);
      expect(manifest.stats.filesParsed).toBe(1);
      expect(manifest.lines_scanned).toBe(11);
    } finally {
      if (prev === undefined) delete process.env.SYNAPSE_DISABLE_WORKERS;
      else process.env.SYNAPSE_DISABLE_WORKERS = prev;
    }
  });
});
