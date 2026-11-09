// src/extractors/languages/typescript-streamed.ts

import fs from "node:fs/promises";
import path from "node:path";
import type { SurfaceManifest } from "../core/surface-manifest.js";
import type { SessionManager } from "../../session/session-manager.js";
import { sniffCandidateFiles } from "../core/prefilter.js";
import { NEEDLE_TABLE } from "../core/needles.js";
import { countLines } from "../../utils/lines.js";
import { parseTypescriptFile, pathTypescriptToModule } from "./typescript-parse.js";

export async function extractTypescriptSurfaceStreamed(opts: {
  workingDir: string;
  session: SessionManager;
  captureFunctions?: boolean;
}): Promise<SurfaceManifest> {
  const { workingDir } = opts;
  const needles = [...NEEDLE_TABLE["typescript"].route];
  const captureFns = opts.captureFunctions !== false;
  const endpoints: any[] = [];
  const functions: any[] = [];
  const frameworkCounts = new Map<string, number>();
  let linesScanned = 0;
  const scannedCache = opts.session.resume.scanned;

  for await (const match of sniffCandidateFiles({
    workingDir,
    needles,
    fileExtensions: [".ts", ".tsx"],
    signal: opts.session.signal,
  })) {
    const cached = scannedCache.get(match.relPath);
    if (cached && cached.sha === match.sha) {
      endpoints.push(...cached.endpoints);
      if (captureFns) functions.push(...cached.functions);
      // Unchanged files still count toward the repo total (SYN-315), the same
      // way python-streamed does, so a rescan that reuses them reports the
      // same lines_scanned as a fresh scan.
      try {
        linesScanned += countLines(
          match.fullHashed ? match.head.toString("utf-8") : await fs.readFile(match.path, "utf-8"),
        );
      } catch {
        /* unreadable now: leave it out of the count */
      }
      continue;
    }
    try {
      const source = await fs.readFile(match.path, "utf-8");
      const result = parseTypescriptFile({ source, relPath: match.relPath, module: pathTypescriptToModule(match.relPath) });
      linesScanned += countLines(source);
      endpoints.push(...result.endpoints);
      if (captureFns) functions.push(...result.functions);
      for (const f of result.frameworkHits) {
        frameworkCounts.set(f, (frameworkCounts.get(f) ?? 0) + 1);
      }
      opts.session.append({
        type: "file_scanned",
        path: match.relPath,
        sha: match.sha,
        endpoints: result.endpoints,
        functions: captureFns ? result.functions : [],
        scanned_at: Date.now(),
        elapsed_ms: 0,
      });
    } catch {
      // skip unparseable files
    }
  }

  let framework: string | null = null;
  let maxCount = 0;
  for (const [fw, count] of frameworkCounts) {
    if (count > maxCount) { maxCount = count; framework = fw; }
  }

  return {
    language: "typescript" as const,
    framework,
    endpoints,
    functions,
    package_import_root: path.basename(workingDir),
    lines_scanned: linesScanned,
  };
}
