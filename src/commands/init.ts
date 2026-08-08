import fs from "node:fs";
import path from "node:path";

import {
  ensureGlobalSynapseDir,
  ensureProjectSynapseDir,
  hasGlobalApiKey,
  isInitialized,
  loadConfig,
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

export interface RunInitOptions {
  force: boolean;
}

// `--local` is a build-time-only override (`synapse build --local`) — a
// project's stored config never pins it to local mode. This keeps mode
// switching a one-shot, per-invocation choice instead of a sticky setting
// you have to re-init to undo.
export async function runInit(opts: RunInitOptions): Promise<void> {
  const workingDir = process.cwd();
  const synapseDir = getProjectSynapseDir(workingDir);

  if (isInitialized(workingDir) && !opts.force) {
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

  await runHostedInit(workingDir, synapseDir);
}

// ---------------------------------------------------------------------------
// Hosted init — the only init flow. Writes mode: "hosted" into the project
// config so downstream commands know which client to use by default;
// `synapse build --local` overrides it per-invocation without touching this.
// ---------------------------------------------------------------------------

async function runHostedInit(workingDir: string, synapseDir: string): Promise<void> {
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

  // Stamp mode: "hosted" on the project config so it's explicit.
  const configPath = path.join(synapseDir, "config.json");
  if (!fs.existsSync(configPath)) {
    saveConfig(workingDir, {
      initialized: true,
      version: "1.0.0",
      mode: "hosted",
      created_at: new Date().toISOString(),
    });
  } else {
    const cfg = loadConfig(workingDir);
    cfg.mode = "hosted";
    saveConfig(workingDir, cfg);
  }

  try {
    const { trackEvent } = await import("../grpc/telemetry.js");
    trackEvent("init", rawKey ?? "", workingDir).catch(() => {});
  } catch {
    /* optional */
  }

  displayWelcome(["synapse analyze", "synapse build", "synapse info"]);
}
