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
import { t, stepOk } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";
import { displayBanner, displayHeader, displayWelcome } from "../ui/banner.js";
import { styledInput } from "../ui/styled-input.js";

export async function runInit(force: boolean): Promise<void> {
  const workingDir = process.cwd();
  const synapseDir = getProjectSynapseDir(workingDir);

  if (isInitialized(workingDir) && !force) {
    roundedBox("Already Initialized", "⚠", t.warn, [
      "Synapse is already initialized in this directory.",
      "",
      `Run ${t.cmd("synapse init --force")} to re-initialize.`,
    ]);
    return;
  }

  displayBanner();
  displayHeader("Initialize", "🎉");

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
    console.log(
      `  ${t.dim("Enter your Synapse API key")}  ${t.subtle("get one at synaps3.ai")}`,
    );
    console.log();
    const inputKey = await styledInput({
      message: "API Key",
      mask: true,
    });
    if (!inputKey || !inputKey.trim()) {
      roundedBox("Missing API Key", "✖", t.err, [
        "API key is required to use Synapse.",
        "",
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
  } catch {
    /* optional */
  }

  displayWelcome([
    "synapse analyze",
    "synapse build",
    "synapse info",
  ]);
}
