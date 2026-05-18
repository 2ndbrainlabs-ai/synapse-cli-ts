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
import {
  t,
  sectionHeader,
  kvLine,
  stepWarn,
  hrLine,
} from "../ui/theme.js";

export async function runInfo(): Promise<void> {
  const workingDir = process.cwd();
  const synapseDir = getProjectSynapseDir(workingDir);

  sectionHeader("Synapse Info");
  console.log();

  // ── Project Status ──────────────────────────────────────────
  printProjectStatus(workingDir, synapseDir);

  // ── Account Quota ───────────────────────────────────────────
  await printQuota(workingDir);

  console.log();
}

function printProjectStatus(workingDir: string, _synapseDir: string): void {
  console.log(`  ${t.bold("Project")}`);
  console.log(`  ${hrLine(50)}`);

  if (!isInitialized(workingDir)) {
    kvLine("Status", "Not initialized");
    console.log(`  ${t.dim("Run")} ${t.cmd("synapse init")} ${t.dim("to get started.")}`);
    console.log();
    return;
  }

  kvLine("Status", "Initialized");

  try {
    const config = loadConfig(workingDir);
    kvLine("Version", config.version ?? "—");

    const created = config.created_at ?? "";
    if (created) {
      try {
        const dt = new Date(created);
        const formatted = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
        kvLine("Created", formatted);
      } catch {
        kvLine("Created", created);
      }
    }
  } catch {
    // Config not found
  }

  const [projDisplay, globalDisplay] = getApiKeyDisplay(workingDir);
  if (projDisplay) {
    kvLine("API key", `${projDisplay} (project)`);
  } else if (globalDisplay) {
    kvLine("API key", `${globalDisplay} (global)`);
  } else {
    kvLine("API key", "Not set");
  }

  // Analysis stats
  const statsPath = getStatisticsPath(workingDir);
  const schemaPath = getProjectSchemaPath(workingDir);
  if (fs.existsSync(statsPath)) {
    try {
      const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
      const files = stats.file_count ?? 0;
      const classes = stats.class_count ?? 0;
      const funcs = stats.function_count ?? 0;
      kvLine("Analyzed", `${files} files · ${classes} classes · ${funcs} functions`);
    } catch {
      // Ignore parse errors
    }
  } else if (fs.existsSync(schemaPath)) {
    kvLine("Analyzed", "Yes");
  } else {
    kvLine("Analyzed", `Not yet  (run 'synapse analyze')`);
  }

  // Index metadata
  const indexMetaPath = getIndexMetadataPath(workingDir);
  if (fs.existsSync(indexMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(indexMetaPath, "utf-8"));
      const count = Array.isArray(meta) ? meta.length : Object.keys(meta).length;
      kvLine("Indexed files", String(count));
    } catch {
      // Ignore
    }
  }

  console.log();
}

async function printQuota(workingDir: string): Promise<void> {
  const apiKey = resolveApiKey(workingDir);

  console.log(`  ${t.bold("Account Quota")}`);
  console.log(`  ${hrLine(50)}`);

  if (!apiKey) {
    console.log(`  ${t.dim("Not available (no API key configured)")}`);
    return;
  }

  const { getQuotaInfo } = await import("../grpc/telemetry.js");
  const info = await getQuotaInfo(apiKey);

  if (!info) {
    console.log(`  ${t.dim("Could not reach backend — check your connection.")}`);
    return;
  }

  const serversUsed = info.mcpServersCount;
  const serversMax = info.maxMcpServers;
  const serversRemaining = Math.max(0, serversMax - serversUsed);
  kvLine("MCP servers", `${serversUsed} / ${serversMax} used  (${serversRemaining} remaining)`);

  const linesUsed = info.linesIndexed;
  const linesMax = info.maxLinesIndexed;
  const linesRemaining = Math.max(0, linesMax - linesUsed);
  kvLine("Lines indexed", `${fmtNumber(linesUsed)} / ${fmtNumber(linesMax)}  (${fmtNumber(linesRemaining)} remaining)`);

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
