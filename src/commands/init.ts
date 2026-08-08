import fs from "node:fs";
import path from "node:path";

import {
  ensureGlobalSynapseDir,
  ensureProjectSynapseDir,
  hasGlobalApiKey,
  isInitialized,
  loadConfig,
  resolveAnthropicKey,
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
  local: boolean;
  anthropicKey?: string | null;
}

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
  displayHeader(opts.local ? "Initialize (local mode)" : "Initialize", "🎉");

  ensureGlobalSynapseDir();
  ensureProjectSynapseDir(workingDir);

  if (opts.local) {
    await runLocalInit(workingDir, synapseDir, opts.anthropicKey ?? null);
    return;
  }

  await runHostedInit(workingDir, synapseDir);
}

// ---------------------------------------------------------------------------
// Hosted init — the original flow, unchanged in behavior. Writes mode: "hosted"
// into the project config so downstream commands know which client to use.
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

// ---------------------------------------------------------------------------
// Local init — validates that an Anthropic key exists (env or --anthropic-key)
// then writes mode: "local" into the project config. The key itself is NEVER
// stored on disk — subsequent builds re-resolve it from env / flag.
// ---------------------------------------------------------------------------

async function runLocalInit(
  workingDir: string,
  synapseDir: string,
  cliFlagKey: string | null,
): Promise<void> {
  const anthropicKey = resolveAnthropicKey(cliFlagKey);
  if (!anthropicKey) {
    printMissingAnthropicKey();
    process.exit(1);
  }

  stepOk("Anthropic API key detected", cliFlagKey ? "from --anthropic-key" : "from ANTHROPIC_API_KEY");

  const configPath = path.join(synapseDir, "config.json");
  if (!fs.existsSync(configPath)) {
    saveConfig(workingDir, {
      initialized: true,
      version: "1.0.0",
      mode: "local",
      created_at: new Date().toISOString(),
    });
  } else {
    const cfg = loadConfig(workingDir);
    cfg.mode = "local";
    if (cfg.initialized === undefined) cfg.initialized = true;
    saveConfig(workingDir, cfg);
  }

  stepOk("Project initialized", "mode: local");

  // Fire telemetry (code-free, mode-tagged). We have no Synapse API key in
  // local mode — trackEvent short-circuits on empty apiKey, so this is a
  // best-effort event that the ui-backend will attribute anonymously via
  // installation_id once the endpoint is updated.
  try {
    const { trackEvent } = await import("../grpc/telemetry.js");
    trackEvent("init.local", "", workingDir).catch(() => {});
  } catch {
    /* optional */
  }

  displayWelcome([
    "synapse analyze",
    "synapse build   # uses ANTHROPIC_API_KEY",
    "synapse info",
  ]);
}

function printMissingAnthropicKey(): void {
  console.log();
  roundedBox("Anthropic API key required", "✖", t.err, [
    "Local mode uses your Anthropic key for codegen (nothing is uploaded).",
    "",
    "Set it in your shell and re-run:",
    `  ${t.cmd("export ANTHROPIC_API_KEY=sk-ant-…")}`,
    `  ${t.cmd("synapse init --local")}`,
    "",
    "Or pass it inline:",
    `  ${t.cmd("synapse init --local --anthropic-key sk-ant-…")}`,
  ]);
}
