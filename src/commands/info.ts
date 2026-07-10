/**
 * synapse info — show project status and account quota usage.
 */

import fs from "node:fs";

import {
  getProjectSynapseDir,
  getStatisticsPath,
  getProjectSchemaPath,
  getIndexMetadataPath,
} from "../config/paths.js";
import {
  isInitialized,
  loadConfig,
  getApiKeyDisplay,
  resolveApiKey,
} from "../config/manager.js";
import { t, sectionHeader, stepWarn } from "../ui/theme.js";
import { kvGrid, type KvRow } from "../ui/kv-grid.js";
import { EMOJI } from "../ui/icons.js";

export async function runInfo(): Promise<void> {
  const workingDir = process.cwd();
  const synapseDir = getProjectSynapseDir(workingDir);

  sectionHeader("Synapse Info", EMOJI.info);

  printProjectStatus(workingDir, synapseDir);
  console.log();
  await printQuota(workingDir);
  console.log();
}

function printProjectStatus(workingDir: string, _synapseDir: string): void {
  console.log(`  ${t.brandBold("Project")}`);
  console.log();

  if (!isInitialized(workingDir)) {
    kvGrid([{ key: "Status", value: "Not initialized" }]);
    console.log();
    console.log(
      `  ${t.dim("Run")} ${t.cmd("synapse init")} ${t.dim("to get started.")}`,
    );
    return;
  }

  const rows: KvRow[] = [{ key: "Status", value: t.ok("Initialized") }];

  try {
    const config = loadConfig(workingDir);
    rows.push({ key: "Version", value: config.version ?? "—" });
    const created = config.created_at ?? "";
    if (created) {
      try {
        const dt = new Date(created);
        const formatted =
          `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-` +
          `${String(dt.getDate()).padStart(2, "0")} ` +
          `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
        rows.push({ key: "Created", value: formatted });
      } catch {
        rows.push({ key: "Created", value: created });
      }
    }
  } catch {
    /* config not found */
  }

  const [projDisplay, globalDisplay] = getApiKeyDisplay(workingDir);
  if (projDisplay) rows.push({ key: "API key", value: `${projDisplay} ${t.dim("(project)")}` });
  else if (globalDisplay) rows.push({ key: "API key", value: `${globalDisplay} ${t.dim("(global)")}` });
  else rows.push({ key: "API key", value: t.subtle("Not set") });

  // Analysis stats
  const statsPath = getStatisticsPath(workingDir);
  const schemaPath = getProjectSchemaPath(workingDir);
  if (fs.existsSync(statsPath)) {
    try {
      const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
      const files = stats.file_count ?? 0;
      const classes = stats.class_count ?? 0;
      const funcs = stats.function_count ?? 0;
      rows.push({
        key: "Analyzed",
        value: `${t.num(String(files))} files ${t.dim("·")} ${t.num(String(classes))} classes ${t.dim("·")} ${t.num(String(funcs))} functions`,
      });
    } catch {
      /* ignore parse errors */
    }
  } else if (fs.existsSync(schemaPath)) {
    rows.push({ key: "Analyzed", value: t.ok("Yes") });
  } else {
    rows.push({
      key: "Analyzed",
      value: `${t.subtle("Not yet")} ${t.dim(`(run ${t.cmd("synapse analyze")})`)}`,
    });
  }

  // Index metadata
  const indexMetaPath = getIndexMetadataPath(workingDir);
  if (fs.existsSync(indexMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(indexMetaPath, "utf-8"));
      const count = Array.isArray(meta) ? meta.length : Object.keys(meta).length;
      rows.push({ key: "Indexed files", value: String(count), numeric: true });
    } catch {
      /* ignore */
    }
  }

  kvGrid(rows);
}

async function printQuota(workingDir: string): Promise<void> {
  const apiKey = resolveApiKey(workingDir);

  console.log(`  ${t.brandBold("Account Quota")}`);
  console.log();

  if (!apiKey) {
    console.log(`  ${t.subtle("Not available (no API key configured)")}`);
    return;
  }

  const { getQuotaInfo } = await import("../grpc/telemetry.js");
  const info = await getQuotaInfo(apiKey);

  if (!info) {
    console.log(`  ${t.subtle("Could not reach backend — check your connection.")}`);
    return;
  }

  const serversUsed = info.mcpServersCount;
  const serversMax = info.maxMcpServers;
  const serversRemaining = Math.max(0, serversMax - serversUsed);

  const linesUsed = info.linesIndexed;
  const linesMax = info.maxLinesIndexed;
  const linesRemaining = Math.max(0, linesMax - linesUsed);

  kvGrid([
    {
      key: "MCP servers",
      value: `${t.num(String(serversUsed))} / ${t.num(String(serversMax))} used  ${t.dim(`(${serversRemaining} remaining)`)}`,
    },
    {
      key: "Lines indexed",
      value: `${t.num(fmtNumber(linesUsed))} / ${t.num(fmtNumber(linesMax))}  ${t.dim(`(${fmtNumber(linesRemaining)} remaining)`)}`,
    },
  ]);

  if (info.quotaExceeded) {
    console.log();
    stepWarn(info.quotaMessage || "Quota exceeded.");
  }
}

function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
