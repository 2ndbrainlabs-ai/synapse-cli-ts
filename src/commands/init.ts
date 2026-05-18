import fs from "node:fs";
import path from "node:path";

import {
  ensureGlobalSynapseDir,
  ensureProjectSynapseDir,
  hasGlobalApiKey,
  isInitialized,
  resolveApiKey,
  saveConfig,
  setGlobalApiKey,
  setProjectApiKey,
} from "../config/manager.js";
import { getProjectSynapseDir } from "../config/paths.js";

export async function runInit(force: boolean): Promise<void> {
  const workingDir = process.cwd();
  const synapseDir = getProjectSynapseDir(workingDir);

  const { t, sectionBox, stepOk } = await import("../ui/theme.js");

  if (isInitialized(workingDir) && !force) {
    sectionBox("Already Initialized", "warn", [
      "Synapse is already initialized in this directory.",
      `Run ${t.cmd("synapse init --force")} to re-initialize.`,
    ]);
    return;
  }

  const { displayBanner, displayHeader } = await import("../ui/banner.js");
  const { promptMaskedInput } = await import("../ui/prompts.js");

  displayBanner();
  displayHeader("Initialize");

  // Ensure directories
  ensureGlobalSynapseDir();
  ensureProjectSynapseDir(workingDir);

  // API key handling
  let rawKey: string | null = null;

  if (hasGlobalApiKey()) {
    rawKey = resolveApiKey();
    if (rawKey) {
      stepOk("Using existing global API key");
      setProjectApiKey(workingDir, rawKey);
    }
  }

  if (!rawKey) {
    console.log();
    console.log(`  ${t.dim("Enter your Synapse API key")}  ${t.muted("get one at synaps3.ai")}`);
    console.log();
    const inputKey = await promptMaskedInput("  API Key: ");
    if (!inputKey || !inputKey.trim()) {
      sectionBox("Missing API Key", "err", [
        "API key is required to use Synapse.",
        `Run ${t.cmd("synapse init")} again to set one.`,
      ]);
      return;
    }
    rawKey = inputKey.trim();
    setGlobalApiKey(rawKey);
    setProjectApiKey(workingDir, rawKey);
    stepOk("API key saved", "encrypted");
  }

  // Create base config if not exists
  const configPath = path.join(synapseDir, "config.json");
  if (!fs.existsSync(configPath)) {
    saveConfig(workingDir, {
      initialized: true,
      version: "1.0.0",
      created_at: new Date().toISOString(),
    });
  }

  // Fire telemetry (non-blocking)
  try {
    const { trackEvent } = await import("../grpc/telemetry.js");
    trackEvent("init", rawKey ?? "", workingDir).catch(() => {});
  } catch { /* optional */ }

  sectionBox("Ready", "ok", [
    "Synapse initialized successfully.",
    "",
    `${t.dim("Next steps:")}`,
    `  ${t.num("1.")} ${t.cmd("synapse analyze")}  ${t.dim("Scan and index your codebase")}`,
    `  ${t.num("2.")} ${t.cmd("synapse build")}    ${t.dim("Generate an MCP server")}`,
  ]);
}
