// src/commands/config.ts
//
// `synapse config` — view and change the CLI's settings.
//
//   synapse config                     show settings; keys are redacted
//   synapse config set-key [key]       verify a Synapse API key, then save it
//   synapse config keys                list the account's active API keys
//   synapse config revoke <id>         revoke one of them
//
// `--key <key>` and `--update` (prompt for a key) are kept as aliases of
// `set-key`. Inference-provider settings for local builds live under
// `synapse model`; `synapse config` shows them and points there.

import {
  getApiUrl,
  getBackendConfig,
  getConfigDisplay,
  hasProjectApiKey,
  isInitialized,
  loadConfig,
  loadGlobalConfig,
  resolveApiKeyWithSource,
  setGlobalApiKey,
  setProjectApiKey,
} from "../config/manager.js";
import { formatApiKeyDisplay } from "../config/api-key-store.js";
import { llmKeyDisplay, resolveLlm } from "../config/llm-config.js";
import {
  ApiKeysError,
  findKeyInUse,
  listApiKeys,
  revokeApiKey,
  type ApiKeyInfo,
} from "../config/api-keys-client.js";
import type { ApiKeyCheck } from "../grpc/telemetry.js";
import { t, stepOk, stepInfo, stepWarn, sectionHeader } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";
import { kvGrid, type KvRow } from "../ui/kv-grid.js";
import { renderTable } from "../ui/table.js";
import { apiKeySourceLabel } from "../ui/errors.js";
import { askConfirm, askSecret, canPrompt } from "../ui/prompt.js";
import { EMOJI } from "../ui/icons.js";

/** Redacted display: the stored 5-character prefix, never more. */
function redact(rawKey: string): string {
  return formatApiKeyDisplay(rawKey.slice(0, 5));
}

function fail(title: string, lines: string[]): void {
  roundedBox(title, "✖", t.err, lines);
  process.exitCode = 1;
}

// -----------------------------------------------------------------------------
// show
// -----------------------------------------------------------------------------

export function runConfigShow(): void {
  const workingDir = process.cwd();
  const initialized = isInitialized(workingDir);

  sectionHeader("Configuration", EMOJI.config);

  // Synapse API key — the one commands will actually use, then what is saved.
  const inUse = resolveApiKeyWithSource(workingDir);
  const projectPrefix = initialized ? (loadConfig(workingDir).api_key_prefix ?? "") : "";
  const globalPrefix = loadGlobalConfig().api_key_prefix ?? "";
  console.log(`  ${t.dim("Synapse API key")}`);
  kvGrid([
    {
      key: "In use",
      value: inUse
        ? `${redact(inUse.key)} ${t.subtle(`(${apiKeySourceLabel(inUse.source)})`)}`
        : t.subtle("(none — run synapse config set-key)"),
    },
    { key: "Project", value: projectPrefix ? formatApiKeyDisplay(projectPrefix) : t.subtle("(not set)") },
    { key: "Global", value: globalPrefix ? formatApiKeyDisplay(globalPrefix) : t.subtle("(not set)") },
  ]);
  if (inUse?.source === "env" && (projectPrefix || globalPrefix)) {
    stepInfo("SYNAPSE_API_KEY is set, so saved keys are ignored.");
  }

  // Project
  console.log();
  console.log(`  ${t.dim("Project")}`);
  if (initialized) {
    const rows: KvRow[] = getConfigDisplay(loadConfig(workingDir))
      .filter(([key]) => key !== "Backend")
      .map(([key, value]) => ({ key, value }));
    kvGrid(rows);
  } else {
    kvGrid([{ key: "Initialized", value: t.subtle(`No — run ${t.cmd("synapse init")}`) }]);
  }

  // Endpoints
  const backend = getBackendConfig();
  console.log();
  console.log(`  ${t.dim("Endpoints")}`);
  kvGrid([
    { key: "API", value: getApiUrl() },
    { key: "Backend", value: backend.url ?? `${backend.host}:${backend.port}` },
  ]);

  // Local inference provider (`synapse build --local`)
  const llm = resolveLlm(workingDir);
  console.log();
  console.log(`  ${t.dim("Local builds")}`);
  kvGrid([
    { key: "Provider", value: `${llm.label} ${t.subtle(`(${llm.source})`)}` },
    { key: "Provider key", value: llmKeyDisplay(llm) },
  ]);
  console.log();
  console.log(`  ${t.subtle(`Change it with ${t.cmd("synapse model set <provider>")}; details: ${t.cmd("synapse model")}.`)}`);
  console.log();
}

// -----------------------------------------------------------------------------
// set-key
// -----------------------------------------------------------------------------

export interface SetKeyOptions {
  /** The key; prompted for (masked) when omitted. */
  key?: string;
  /** Save to ~/.synapse only, leaving this project's saved key alone. */
  globalScope?: boolean;
}

/**
 * Verify a Synapse API key against the backend (GET /quota), then save it,
 * encrypted. A key the backend rejects is never saved. When the backend
 * can't be reached the key is saved with a warning, like `synapse init`.
 *
 * Saved to ~/.synapse. A key already saved in this project would shadow the
 * global one, so it is replaced too, unless --global is given.
 */
export async function runConfigSetKey(opts: SetKeyOptions): Promise<void> {
  const workingDir = process.cwd();

  let key = (opts.key ?? "").trim();
  if (!key) {
    if (!canPrompt()) {
      fail("Missing API Key", [
        "No key given and there is no terminal to prompt on.",
        "",
        `Pass it as ${t.cmd("synapse config set-key <KEY>")}, or set ${t.cmd("SYNAPSE_API_KEY")}.`,
      ]);
      return;
    }
    console.log();
    console.log(`  ${t.dim("Enter your Synapse API key")}  ${t.subtle("get one at synapse.2ndbrainlabs.ai")}`);
    console.log();
    key = (await askSecret({ message: "API Key" })).trim();
    if (!key) {
      fail("Missing API Key", ["No key entered. Nothing was changed."]);
      return;
    }
  }

  const { verifyApiKey } = await import("../grpc/telemetry.js");
  const check: ApiKeyCheck = await verifyApiKey(key, {
    onRetry: () => stepInfo("Waking up Synapse…", "this can take up to 30 seconds after a quiet spell"),
  });
  if (check === "rejected") {
    fail("API Key Rejected", [
      "Synapse rejected this key. It may be invalid, expired or revoked.",
      "Nothing was saved; your current key is unchanged.",
    ]);
    return;
  }

  setGlobalApiKey(key);
  const updateProject = !opts.globalScope && hasProjectApiKey(workingDir);
  if (updateProject) setProjectApiKey(workingDir, key);

  if (check === "valid") stepOk("API key verified");
  else stepWarn("Couldn't reach Synapse to verify the key", "saved anyway");
  stepOk(
    updateProject ? "API key saved for this project and globally" : "Global API key saved",
    `${redact(key)} · encrypted`,
  );

  if (opts.globalScope && hasProjectApiKey(workingDir)) {
    stepWarn(
      "This project has its own saved key, which takes precedence here",
      `run ${t.cmd("synapse config set-key")} without --global to replace it`,
    );
  }
  if ((process.env.SYNAPSE_API_KEY ?? "").trim()) {
    stepWarn("SYNAPSE_API_KEY is set and overrides saved keys", "unset it to use the saved key");
  }
}

// -----------------------------------------------------------------------------
// keys / revoke
// -----------------------------------------------------------------------------

function requireKey(): { key: string; source: Parameters<typeof apiKeySourceLabel>[0] } | null {
  const inUse = resolveApiKeyWithSource(process.cwd());
  if (!inUse) {
    fail("No API Key", [
      "There is no Synapse API key to authenticate with.",
      "",
      `Save one with ${t.cmd("synapse config set-key")}, or set ${t.cmd("SYNAPSE_API_KEY")}.`,
    ]);
  }
  return inUse;
}

function reportApiError(e: unknown, action: string): void {
  const message = e instanceof ApiKeysError || e instanceof Error ? e.message : String(e);
  fail(`Couldn't ${action}`, [message]);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export async function runConfigKeys(): Promise<void> {
  const inUse = requireKey();
  if (!inUse) return;

  let keys: ApiKeyInfo[];
  try {
    keys = await listApiKeys(inUse.key);
  } catch (e) {
    reportApiError(e, "list API keys");
    return;
  }

  sectionHeader("API keys", EMOJI.config);
  if (keys.length === 0) {
    stepInfo("No active API keys on this account.");
    console.log();
    return;
  }
  const current = findKeyInUse(inUse.key, keys);
  renderTable(keys, [
    { header: "Id", get: (k) => k.id },
    { header: "Key", get: (k) => `${k.keyPrefix}…` },
    { header: "Name", get: (k) => (k.id === current?.id ? `${k.name} ${t.brand("(in use)")}` : k.name) },
    { header: "Created", get: (k) => day(k.createdAt) },
    { header: "Last used", get: (k) => day(k.lastUsed) },
    { header: "Expires", get: (k) => day(k.expiresAt) },
  ]);
  console.log();
  console.log(`  ${t.subtle(`Revoke one with ${t.cmd("synapse config revoke <id>")}.`)}`);
  console.log();
}

export interface RevokeOptions {
  /** Skip the confirmation prompt. */
  yes?: boolean;
}

/**
 * Revoke one of the account's API keys. Revocation is permanent: the API
 * rejects the key at once, the build backend within about 30 seconds.
 * Revoking the key this CLI is using needs an explicit confirmation, since
 * every later command fails until a new key is saved.
 */
export async function runConfigRevoke(keyId: string, opts: RevokeOptions): Promise<void> {
  const inUse = requireKey();
  if (!inUse) return;

  let keys: ApiKeyInfo[];
  try {
    keys = await listApiKeys(inUse.key);
  } catch (e) {
    reportApiError(e, "revoke the API key");
    return;
  }

  const target = keys.find((k) => k.id === keyId.trim());
  if (!target) {
    fail("Key Not Found", [
      `No active API key with id ${keyId} on this account.`,
      "",
      `List them with ${t.cmd("synapse config keys")}.`,
    ]);
    return;
  }

  const isCurrent = findKeyInUse(inUse.key, keys)?.id === target.id;
  if (!opts.yes) {
    if (!canPrompt()) {
      fail("Confirmation Needed", [
        `Pass ${t.cmd("--yes")} to revoke without a prompt.`,
      ]);
      return;
    }
    const question = isCurrent
      ? `Revoke "${target.name}"? It is the key this CLI uses — commands will fail until you save a new one.`
      : `Revoke "${target.name}" (${target.keyPrefix}…)? This can't be undone.`;
    if (!(await askConfirm({ message: question, defaultValue: false }))) {
      stepInfo("Nothing was revoked.");
      return;
    }
  }

  try {
    await revokeApiKey(inUse.key, target.id);
  } catch (e) {
    reportApiError(e, "revoke the API key");
    return;
  }

  stepOk(`Revoked "${target.name}"`, target.id);
  stepInfo("Synapse no longer accepts it.");
  if (isCurrent) {
    stepWarn(
      `That was the key in use (${apiKeySourceLabel(inUse.source)})`,
      `save a new one with ${t.cmd("synapse config set-key")}`,
    );
  }
}
