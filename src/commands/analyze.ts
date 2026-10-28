import { isInitialized, resolveApiKey } from "../config/manager.js";
import { getProjectSynapseDir } from "../config/paths.js";
import {
  analyzeCodebase,
  saveAnalysisResults,
} from "../analyzer/codebase-analyzer.js";
import type { ProjectStatistics } from "../analyzer/codebase-analyzer.js";
import { t, stepOk, sectionHeader } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";
import { Spinner } from "../ui/spinner.js";
import { kvGrid } from "../ui/kv-grid.js";
import { displayHeader } from "../ui/banner.js";
import { EMOJI, OK } from "../ui/icons.js";
import { reportIndexedLines, showQuotaExceeded } from "./shared/lines-delta.js";

/** error_code for a failed analyze in telemetry. */
export const ANALYZE_FAILED = "ANALYZE_FAILED";

export async function runAnalyze(
  outputDir: string,
  verbose: boolean,
): Promise<void> {
  const workingDir = process.cwd();

  if (!isInitialized(workingDir)) {
    roundedBox("Not Initialized", "✖", t.err, [
      "Synapse is not initialized in this directory.",
      "",
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
        roundedBox("Quota Exceeded", "⚠", t.warn, [message]);
        return;
      }
    }
  } catch {
    /* fail open */
  }

  try {
    displayHeader("Analyze Codebase", EMOJI.analyze);

    // Register parsers
    const { PythonParser } = await import("../parsers/python/index.js");
    const { registerParser } = await import("../parsers/registry.js");
    registerParser(new PythonParser());

    // Step 1: Scan
    const spinner = new Spinner("ellipsis");
    spinner.start("Scanning codebase");
    const [schemaText, statistics] = analyzeCodebase(workingDir);
    spinner.complete(
      `Scanned codebase — ${statistics.file_count} files, ${statistics.class_count} classes, ${statistics.function_count} functions`,
    );

    // Step 2: Save results
    const synapseDir = getProjectSynapseDir(workingDir);
    saveAnalysisResults(synapseDir, schemaText, statistics);
    stepOk("Saved project schema and statistics");

    const chunkCount = statistics.function_count + statistics.class_count;

    // Results summary
    console.log();
    renderResults(statistics, chunkCount, outputDir);

    // Quota accounting — report only the lines not reported before. The
    // baseline in statistics.prev.json moves only when the server accepts the
    // event, so lines from a failed send are sent again next run (SYN-315).
    try {
      const report = await reportIndexedLines({
        apiKey: resolveApiKey(workingDir) ?? "",
        workingDir,
        synapseDir,
        totalLines: statistics.total_lines_analyzed,
        key: "total_lines_analyzed",
        outcome: { success: true },
      });
      if (report.kind === "quota_exceeded") showQuotaExceeded(report.message);
    } catch {
      /* optional */
    }
  } catch (err) {
    sendAnalyzeFailure(workingDir);
    roundedBox("Analysis Failed", "✖", t.err, [
      err instanceof Error ? err.message : String(err),
    ]);
    if (verbose && err instanceof Error && err.stack) {
      console.log(`\n${t.dim(err.stack)}`);
    }
  }
}

/** Report a failed analyze (SYN-321) — fire-and-forget, never throws. */
function sendAnalyzeFailure(workingDir: string): void {
  let apiKey = "";
  try {
    apiKey = resolveApiKey(workingDir) ?? "";
  } catch {
    /* optional */
  }
  if (!apiKey) return;
  void import("../grpc/telemetry.js")
    .then(({ trackEvent }) =>
      trackEvent("analyze", apiKey, workingDir, 0, 0, 0, 0, "hosted", {
        success: false,
        errorCode: ANALYZE_FAILED,
      }),
    )
    .catch(() => {});
}

function renderResults(
  stats: ProjectStatistics,
  chunkCount: number,
  outputDir: string,
): void {
  const rows = [
    { key: "Directories", value: String(stats.directory_count), numeric: true, icon: EMOJI.folder },
    { key: "Files", value: String(stats.file_count), numeric: true, icon: EMOJI.file },
    { key: "Lines", value: stats.total_lines_analyzed.toLocaleString(), numeric: true },
    { key: "Classes", value: String(stats.class_count), numeric: true, icon: EMOJI.pkg },
    { key: "Functions", value: String(stats.function_count), numeric: true, icon: EMOJI.spark },
    { key: "Methods", value: String(stats.method_count), numeric: true, icon: EMOJI.wrench },
    { key: "Chunks", value: String(chunkCount), numeric: true },
  ];

  sectionHeader("Analysis Complete", "✓");
  kvGrid(rows, { rightAlignValues: true });

  console.log();
  console.log(`  ${t.dim("Output:")}`);
  console.log(`    ${t.ok(OK)} ${t.path(`${outputDir}/project_schema.txt`)}`);
  console.log(`    ${t.ok(OK)} ${t.path(`${outputDir}/statistics.json`)}`);
  console.log();
  console.log(`  ${t.dim("Next:")}  ${t.cmd("synapse build")}`);
  console.log();
}
