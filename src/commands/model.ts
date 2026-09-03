// src/commands/model.ts
//
// `synapse model` — inspect and switch the inference provider used by local
// codegen (`synapse build --local`).
//
// Hosted builds run on the Synapse service and are NOT affected by these
// settings; the command says so explicitly, because "synapse model" reads like
// it should change everything.
//
//   synapse model                              show what a local build would use
//   synapse model list                         providers, defaults, key status
//   synapse model set groq                     switch, keep provider defaults
//   synapse model set groq --model <id>        switch and pin every stage
//   synapse model set openai --generate <id> --triage <id>
//   synapse model set custom --base-url <url> --model <id>
//   synapse model set <p> --save-key <key>     persist the key (encrypted)
//   synapse model reset                        drop the saved block

import {
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  keyFromEnv,
} from "../providers/catalog.js";
import type { ProviderId, Task } from "../providers/types.js";
import {
  TASKS,
  clearLlmSettings,
  encryptApiKey,
  llmKeyDisplay,
  readGlobalLlmSettings,
  readProjectLlmSettings,
  resolveLlm,
  writeLlmSettings,
  type ConfigScope,
  type LlmSettings,
} from "../config/llm-config.js";
import { t, sectionHeader, stepOk, stepInfo, stepWarn } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";
import { kvGrid, type KvRow } from "../ui/kv-grid.js";
import { renderTable } from "../ui/table.js";

export interface ModelOptions {
  /** Per-stage overrides. */
  model?: string;
  triage?: string;
  generate?: string;
  verify?: string;
  fallback?: string;
  baseUrl?: string;
  /** Persist the key, Fernet-encrypted and machine-bound. Opt-in. */
  saveKey?: string;
  /** Extra request headers, repeatable `Name: value`. */
  header?: string[];
  /** Endpoint ignores tool_choice — coerce JSON output instead. */
  noToolChoice?: boolean;
  /** Endpoint wants max_completion_tokens instead of max_tokens. */
  maxCompletionTokens?: boolean;
  /** Endpoint rejects `temperature`. */
  noTemperature?: boolean;
  globalScope?: boolean;
}

function scopeOf(opts: ModelOptions): ConfigScope {
  return opts.globalScope ? "global" : "project";
}

function parseHeaders(raw: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw ?? []) {
    const idx = entry.indexOf(":");
    if (idx <= 0) {
      throw new Error(`Bad --header "${entry}". Use --header "Name: value".`);
    }
    out[entry.slice(0, idx).trim()] = entry.slice(idx + 1).trim();
  }
  return out;
}

// -----------------------------------------------------------------------------
// show
// -----------------------------------------------------------------------------

export function runModelShow(): void {
  const workingDir = process.cwd();
  const resolved = resolveLlm(workingDir);

  sectionHeader("Inference provider", "🧠");

  const rows: KvRow[] = [
    { key: "Provider", value: `${resolved.label} ${t.subtle(`(${resolved.source})`)}` },
    { key: "API key", value: llmKeyDisplay(resolved) },
  ];
  if (resolved.baseUrl) rows.push({ key: "Endpoint", value: resolved.baseUrl });
  kvGrid(rows);

  console.log();
  console.log(`  ${t.dim("Models")}`);
  kvGrid(
    TASKS.map((task) => ({
      key: task,
      value: resolved.models[task] || t.subtle("(not set)"),
    })),
  );

  if (!resolved.caps.toolChoice) {
    console.log();
    stepInfo("Endpoint ignores tool_choice — Synapse coerces JSON output instead.");
  }

  for (const warning of resolved.warnings) stepWarn(warning);

  console.log();
  if (resolved.problems.length > 0) {
    roundedBox(`${resolved.label} not ready`, "✖", t.err, [
      ...resolved.problems,
      "",
      `Change provider with ${t.cmd("synapse model set <provider>")}.`,
    ]);
  } else {
    stepOk(`Ready — ${t.cmd("synapse build --local")} will use ${resolved.label}.`);
  }

  console.log();
  console.log(
    `  ${t.subtle("Applies to local builds only. Hosted builds run on the Synapse service.")}`,
  );
  console.log(`  ${t.subtle(`See all providers: ${t.cmd("synapse model list")}`)}`);
  console.log();
}

// -----------------------------------------------------------------------------
// list
// -----------------------------------------------------------------------------

export function runModelList(): void {
  const workingDir = process.cwd();
  const active = resolveLlm(workingDir).providerId;

  sectionHeader("Available providers", "🧠");

  renderTable(
    PROVIDER_IDS.map((id) => {
      const spec = PROVIDERS[id];
      const hasKey = Boolean(keyFromEnv(id));
      return {
        id,
        name: spec.label + (id === active ? t.ok(" ●") : ""),
        model: spec.defaults.generate || t.subtle("(you supply)"),
        key: !spec.keyRequired
          ? t.subtle("not needed")
          : hasKey
            ? t.ok(spec.apiKeyEnv[0])
            : t.subtle(spec.apiKeyEnv[0]),
      };
    }),
    [
      { header: "ID", get: (r) => r.id },
      { header: "Provider", get: (r) => r.name },
      { header: "Default model", get: (r) => r.model },
      { header: "Key env var", get: (r) => r.key },
    ],
  );

  console.log();
  console.log(`  ${t.subtle("● = active")}   ${t.subtle("green env var = key found")}`);
  console.log(`  ${t.dim("Switch:")} ${t.cmd("synapse model set groq")}`);
  console.log(
    `  ${t.dim("Pin a model:")} ${t.cmd("synapse model set openai --model gpt-5")}`,
  );
  console.log(
    `  ${t.dim("Self-hosted:")} ${t.cmd('synapse model set custom --base-url http://localhost:8000/v1 --model my-model')}`,
  );
  console.log();
  console.log(
    `  ${t.subtle("Model ids change often — Synapse does not validate them, so any id your provider accepts works.")}`,
  );
  console.log();
}

// -----------------------------------------------------------------------------
// set
// -----------------------------------------------------------------------------

export function runModelSet(providerArg: string, opts: ModelOptions): void {
  const workingDir = process.cwd();
  const scope = scopeOf(opts);

  if (!isProviderId(providerArg)) {
    roundedBox("Unknown provider", "✖", t.err, [
      `"${providerArg}" is not a known provider.`,
      "",
      `Known: ${PROVIDER_IDS.join(", ")}`,
      "",
      `List them with ${t.cmd("synapse model list")}.`,
    ]);
    return;
  }

  const providerId: ProviderId = providerArg;
  const spec = PROVIDERS[providerId];

  // Start from the existing block only when it belongs to this provider, so
  // switching providers never inherits the previous one's model ids.
  const existing =
    scope === "global"
      ? readGlobalLlmSettings().settings
      : readProjectLlmSettings(workingDir).settings;
  const base: LlmSettings =
    existing && existing.provider === providerId
      ? { ...existing }
      : { provider: providerId };
  base.provider = providerId;

  // --- endpoint ---
  const baseUrl = (opts.baseUrl ?? "").trim();
  if (baseUrl) {
    try {
      // Surface a bad URL here rather than as a fetch failure mid-build.
      new URL(baseUrl);
    } catch {
      roundedBox("Invalid --base-url", "✖", t.err, [
        `"${baseUrl}" is not a valid URL.`,
        "",
        `Example: ${t.cmd("http://localhost:8000/v1")}`,
      ]);
      return;
    }
    base.base_url = baseUrl;
  }
  if (!base.base_url && !spec.baseUrl && spec.kind === "openai-compat") {
    roundedBox(`${spec.label} needs an endpoint`, "✖", t.err, [
      `Provider "${providerId}" has no default endpoint.`,
      "",
      "Pass one:",
      `  ${t.cmd(`synapse model set ${providerId} --base-url <url> --model <id>`)}`,
      "",
      "It must expose POST {base-url}/chat/completions in OpenAI format.",
    ]);
    return;
  }

  // --- models ---
  const perStage: Partial<Record<Task, string>> = { ...(base.models ?? {}) };
  const single = (opts.model ?? "").trim();
  if (single) for (const task of TASKS) perStage[task] = single;
  if (opts.triage?.trim()) perStage.triage = opts.triage.trim();
  if (opts.generate?.trim()) perStage.generate = opts.generate.trim();
  if (opts.verify?.trim()) perStage.verify = opts.verify.trim();
  if (opts.fallback?.trim()) perStage.fallback_generate = opts.fallback.trim();
  if (Object.keys(perStage).length > 0) base.models = perStage;

  const missing = TASKS.filter((task) => !(perStage[task] || spec.defaults[task]));
  if (missing.length > 0) {
    roundedBox(`${spec.label} needs a model`, "✖", t.err, [
      `Provider "${providerId}" has no default model.`,
      "",
      "Pass one:",
      `  ${t.cmd(`synapse model set ${providerId} --model <id>`)}`,
    ]);
    return;
  }

  // --- headers / capability overrides ---
  try {
    const headers = parseHeaders(opts.header);
    if (Object.keys(headers).length > 0) {
      base.headers = { ...(base.headers ?? {}), ...headers };
    }
  } catch (e) {
    roundedBox("Invalid --header", "✖", t.err, [(e as Error).message]);
    return;
  }
  if (opts.noToolChoice) base.tool_choice = false;
  if (opts.maxCompletionTokens) base.max_tokens_field = "max_completion_tokens";
  if (opts.noTemperature) base.temperature = false;

  // --- key (opt-in persistence) ---
  const saveKey = (opts.saveKey ?? "").trim();
  if (saveKey) {
    const [prefix, encrypted] = encryptApiKey(saveKey);
    base.api_key_prefix = prefix;
    base.api_key_encrypted = encrypted;
  }

  try {
    writeLlmSettings(scope, workingDir, base);
  } catch (e) {
    roundedBox("Could not save", "✖", t.err, [(e as Error).message]);
    return;
  }

  const target = scope === "global" ? "~/.synapse/config.json" : ".synapse/config.json";
  stepOk(`Local codegen set to ${spec.label}`, t.subtle(target));

  const resolved = resolveLlm(workingDir);
  kvGrid([
    { key: "generate", value: resolved.models.generate },
    { key: "triage", value: resolved.models.triage },
    ...(resolved.baseUrl ? [{ key: "endpoint", value: resolved.baseUrl }] : []),
    { key: "API key", value: llmKeyDisplay(resolved) },
  ]);

  if (saveKey) {
    console.log();
    stepWarn(
      `Key stored encrypted in ${target} and bound to this machine. ` +
        `It will not decrypt elsewhere. Remove it with ${t.cmd("synapse model reset")}.`,
    );
  }

  if (spec.note) {
    console.log();
    stepInfo(spec.note);
  }

  for (const warning of resolved.warnings) stepWarn(warning);

  console.log();
  if (resolved.problems.length > 0) {
    roundedBox("One more step", "⚠", t.warn, resolved.problems);
  } else {
    console.log(`  ${t.dim("Try it:")} ${t.cmd("synapse build --local")}`);
  }
  console.log();
}

// -----------------------------------------------------------------------------
// reset
// -----------------------------------------------------------------------------

export function runModelReset(opts: ModelOptions): void {
  const workingDir = process.cwd();
  const scope = scopeOf(opts);
  clearLlmSettings(scope, workingDir);
  stepOk(
    `Cleared the ${scope} inference config`,
    t.subtle("local builds fall back to Anthropic"),
  );
}
