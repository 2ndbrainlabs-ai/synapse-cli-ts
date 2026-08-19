// src/extractors/languages/java-streamed.ts

import fs from "node:fs/promises";
import path from "node:path";
import type { SurfaceManifest } from "../core/surface-manifest.js";
import type { SessionManager } from "../../session/session-manager.js";
import { sniffCandidateFiles } from "../core/prefilter.js";
import { NEEDLE_TABLE } from "../core/needles.js";
import { parseJavaFile, pathJavaToModule } from "./java-parse.js";

export async function extractJavaSurfaceStreamed(opts: {
  workingDir: string;
  session: SessionManager;
  captureFunctions?: boolean;
}): Promise<SurfaceManifest> {
  const { workingDir } = opts;
  const needles = [...NEEDLE_TABLE["java"].route];
  const endpoints: any[] = [];
  const functions: any[] = [];
  const frameworkCounts = new Map<string, number>();

  for await (const match of sniffCandidateFiles({
    workingDir,
    needles,
    fileExtensions: [".java"],
    signal: opts.session.signal,
  })) {
    try {
      const source = await fs.readFile(match.path, "utf-8");
      const result = parseJavaFile({ source, relPath: match.relPath, module: pathJavaToModule(match.relPath) });
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
    language: "java" as const,
    framework,
    endpoints,
    functions,
    package_import_root: path.basename(workingDir),
  };
}
