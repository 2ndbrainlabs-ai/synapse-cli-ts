import fs from "node:fs";
import path from "node:path";

import {
  ensureGlobalSynapseDir,
  ensureProjectSynapseDir,
  isInitialized,
  loadConfig,
  resolveApiKeyWithSource,
  saveConfig,
  setGlobalApiKey,
  setProjectApiKey,
  type ApiKeySource,
} from "../config/manager.js";
import { getProjectSynapseDir } from "../config/paths.js";
import { t, stepOk, stepInfo } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";
import { apiKeySourceLabel, ERROR_CODES } from "../ui/errors.js";
import { displayBanner, displayHeader, displayWelcome } from "../ui/banner.js";
import type { ApiKeyCheck } from "../grpc/telemetry.js";
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
  let keySource: ApiKeySource | "entered" = "entered";

  const existing = resolveApiKeyWithSource(workingDir);
  if (existing) {
    rawKey = existing.key;
    keySource = existing.source;
    stepOk(`Using existing API key from ${apiKeySourceLabel(existing.source)}`);
    // Copy a saved global key into this project, as before. A key from the
    // environment is used as-is and never written to disk.
    if (existing.source === "global") setProjectApiKey(workingDir, rawKey);
  }

  if (!rawKey) {
    console.log();
    console.log(
      `  ${t.dim("Enter your Synapse API key")}  ${t.subtle("get one at synapse.2ndbrainlabs.ai")}`,
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

  const keyCheck = await checkApiKey(rawKey, keySource);

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

  // Init itself always completes; a key the backend rejected is the one way
  // it ends unusable. An unverified key (backend unreachable) still counts
  // as success — init is offline-tolerant.
  try {
    const { trackEvent } = await import("../grpc/telemetry.js");
    const outcome =
      keyCheck === "rejected"
        ? { success: false, errorCode: ERROR_CODES.AUTH_INVALID }
        : { success: true };
    trackEvent("init", rawKey ?? "", workingDir, 0, 0, 0, 0, "hosted", outcome).catch(() => {});
  } catch {
    /* optional */
  }

  displayWelcome(["synapse analyze", "synapse build", "synapse info"]);
}

/**
 * Check the key against the backend (GET /quota) so a bad key shows up now
 * rather than mid-build. Offline-tolerant: if the backend can't be reached
 * the key is kept and init carries on. If the first attempt times out, the
 * API is probably cold-starting, so say so while the retry runs.
 */
async function checkApiKey(
  rawKey: string,
  source: ApiKeySource | "entered",
): Promise<ApiKeyCheck> {
  const { verifyApiKey } = await import("../grpc/telemetry.js");
  const result = await verifyApiKey(rawKey, {
    onRetry: () => stepInfo("Waking up Synapse…", "this can take up to 30 seconds after a quiet spell"),
  });

  if (result === "valid") {
    stepOk("API key verified");
    return result;
  }
  if (result === "unknown") {
    stepInfo("Couldn't reach Synapse to verify the API key", "continuing offline");
    return result;
  }

  const from = source === "entered" ? "you entered" : `from ${apiKeySourceLabel(source)}`;
  const fix =
    source === "env"
      ? [
          `${t.cmd("SYNAPSE_API_KEY")} overrides saved keys. Set it to a valid key,`,
          "or unset it to use a saved one.",
        ]
      : [`Save a valid key with ${t.cmd("synapse config set-key")}, or set ${t.cmd("SYNAPSE_API_KEY")}.`];
  roundedBox("API Key Rejected", "⚠", t.warn, [
    `Synapse rejected the API key ${from}.`,
    "It may be invalid, expired or revoked — builds will fail until it's replaced.",
    "",
    ...fix,
  ]);
  return result;
}
