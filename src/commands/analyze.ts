import fs from "node:fs";
import path from "node:path";
import { isInitialized, resolveApiKey } from "../config/manager.js";
import { getProjectSynapseDir } from "../config/paths.js";
import {
  analyzeCodebase,
  saveAnalysisResults,
} from "../analyzer/codebase-analyzer.js";
import type { ProjectStatistics } from "../analyzer/codebase-analyzer.js";

export async function runAnalyze(
  outputDir: string,
  verbose: boolean,
): Promise<void> {
  const workingDir = process.cwd();

  const { t, stepOk, stepWarn, sectionBox } = await import("../ui/theme.js");

  if (!isInitialized(workingDir)) {
    sectionBox("Not Initialized", "err", [
      "Synapse is not initialized in this directory.",
      `Run ${t.cmd("synapse init")} first.`,
    ]);
    return;
  }

  // Pre-flight quota check
  try {
    const apiKey = resolveApiKey(workingDir) ?? "";
    if (apiKey) {
      const { checkQuota } = await import("../grpc/telemetry.js");
      const [exceeded, message] = await checkQuota(apiKey);
      if (exceeded) {
        sectionBox("Quota Exceeded", "warn", [message]);
        return;
      }
    }
  } catch { /* fail open */ }

  try {
    const { displayBanner, displayHeader } = await import("../ui/banner.js");

    displayBanner();
    displayHeader("Analyze Codebase");
    console.log();

    // Register parsers
    const { PythonParser } = await import("../parsers/python/index.js");
    const { registerParser } = await import("../parsers/registry.js");
    registerParser(new PythonParser());

    // Step 1: Scan codebase
    const [schemaText, statistics] = analyzeCodebase(workingDir);
    stepOk(
      "Scanned codebase",
      `${statistics.file_count} files ${t.dim("·")} ${statistics.class_count} classes ${t.dim("·")} ${statistics.function_count} functions`,
    );

    // Step 2: Save results
    const synapseDir = getProjectSynapseDir(workingDir);
    saveAnalysisResults(synapseDir, schemaText, statistics);
    stepOk("Saved project schema and statistics");

    // Step 3: Index code chunks (incremental if metadata exists)
    const chunkCount = statistics.function_count + statistics.class_count;
    stepOk("Codebase analyzed", `${chunkCount} functions/classes found`);

    // Results summary
    console.log();
    renderResults(statistics, chunkCount, outputDir);

    // Telemetry — only report delta lines (newly analyzed)
    try {
      const { trackEvent } = await import("../grpc/telemetry.js");
      const apiKey = resolveApiKey(workingDir) ?? "";
      const totalLines = statistics.total_lines_analyzed;

      let prevLines = 0;
      const prevStatsPath = path.join(synapseDir, "statistics.prev.json");
      try {
        if (fs.existsSync(prevStatsPath)) {
          prevLines = JSON.parse(fs.readFileSync(prevStatsPath, "utf-8")).total_lines_analyzed ?? 0;
        }
      } catch { /* ignore */ }

      const delta = Math.max(totalLines - prevLines, 0);
      if (delta > 0 && apiKey) {
        trackEvent("analyze", apiKey, workingDir, delta).catch(() => {});
      }

      try {
        fs.writeFileSync(prevStatsPath, JSON.stringify({ total_lines_analyzed: totalLines }));
      } catch { /* non-fatal */ }
    } catch { /* optional */ }
  } catch (err) {
    sectionBox("Analysis Failed", "err", [
      err instanceof Error ? err.message : String(err),
    ]);
    if (verbose && err instanceof Error && err.stack) {
      console.log(`\n${t.dim(err.stack)}`);
    }
  }
}

async function renderResults(
  stats: ProjectStatistics,
  chunkCount: number,
  outputDir: string,
): Promise<void> {
  const { t, sectionBox } = await import("../ui/theme.js");

  sectionBox("Analysis Complete", "ok", [
    "",
    `${t.dim("Directories")}   ${t.num(String(stats.directory_count))}`,
    `${t.dim("Files")}         ${t.num(String(stats.file_count))}`,
    `${t.dim("Lines")}         ${t.num(String(stats.total_lines_analyzed))}`,
    `${t.dim("Classes")}       ${t.num(String(stats.class_count))}`,
    `${t.dim("Functions")}     ${t.num(String(stats.function_count))}`,
    `${t.dim("Methods")}       ${t.num(String(stats.method_count))}`,
    `${t.dim("Code Chunks")}   ${t.num(String(chunkCount))}`,
    "",
    `${t.dim("Output:")}`,
    `  ${t.ok("✓")} ${t.path(`${outputDir}/project_schema.txt`)}`,
    `  ${t.ok("✓")} ${t.path(`${outputDir}/statistics.json`)}`,
    `  ${t.ok("✓")} ${t.path(`${outputDir}/code_context`)}`,
    "",
    `${t.dim("Next:")} ${t.cmd("synapse build")}`,
  ]);
}
