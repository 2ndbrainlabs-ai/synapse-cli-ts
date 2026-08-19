// src/extractors/languages/typescript-streamed.ts

import fs from "node:fs/promises";
import path from "node:path";
import type { SurfaceManifest } from "../core/surface-manifest.js";
import type { SessionManager } from "../../session/session-manager.js";
import { sniffCandidateFiles } from "../core/prefilter.js";
import { NEEDLE_TABLE } from "../core/needles.js";
import { parseTypescriptFile, pathTypescriptToModule } from "./typescript-parse.js";

export async function extractTypescriptSurfaceStreamed(opts: {
  workingDir: string;
  session: SessionManager;
  captureFunctions?: boolean;
}): Promise<SurfaceManifest> {
  const { workingDir } = opts;
  const needles = [...NEEDLE_TABLE["typescript"].route];
  const endpoints: any[] = [];
  const functions: any[] = [];
  const frameworkCounts = new Map<string, number>();

  for await (const match of sniffCandidateFiles({
    workingDir,
    needles,
    fileExtensions: [".ts", ".tsx"],
    signal: opts.session.signal,
  })) {
    try {
      const source = await fs.readFile(match.path, "utf-8");
      const result = parseTypescriptFile({ source, relPath: match.relPath, module: pathTypescriptToModule(match.relPath) });
      endpoints.push(...result.endpoints);
      if (opts.captureFunctions !== false) functions.push(...result.functions);
      for (const f of result.frameworkHits) {
        frameworkCounts.set(f, (frameworkCounts.get(f) ?? 0) + 1);
      }
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
  };
}
