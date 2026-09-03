// src/config/llm-config.ts
//
// Owns "which model does --local mode run on". One resolver, one schema, one
// place that knows the precedence order — commands ask for a ResolvedLlm and
// never read env vars or config files themselves.
//
// SCOPE: this configures LOCAL mode only (`synapse build --local`). Hosted
// builds run on the Synapse service and are unaffected by these settings.
//
// SECRETS: the pre-existing invariant is that inference keys are never written
// to disk. That still holds by default — keys come from env vars each run.
// `synapse model set --save-key` is an explicit opt-in that stores the key
// Fernet-encrypted and machine-bound (same scheme as the Synapse API key), and
// says so at the time.

import { z } from "zod";

import {
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  keyFromEnv,
  type ProviderCaps,
  type ProviderSpec,
} from "../providers/catalog.js";
import type { ProviderId, Task } from "../providers/types.js";
import {
  decryptApiKey,
  encryptApiKey,
  formatApiKeyDisplay,
} from "./api-key-store.js";
import {
  loadConfig,
  loadGlobalConfig,
  saveConfig,
  saveGlobalConfig,
  isInitialized,
} from "./manager.js";

// -----------------------------------------------------------------------------
// Persisted schema — the `llm` block of .synapse/config.json (project) or
// ~/.synapse/config.json (global).
// -----------------------------------------------------------------------------

export const TASKS = [
  "triage",
  "generate",
  "verify",
  "fallback_generate",
] as const;

export const LlmSettingsSchema = z
  .object({
    /** Which provider family drives local codegen. */
    provider: z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]),
    /** Endpoint root. Required for `custom`; overrides the default otherwise. */
    base_url: z.string().url().optional(),
    /** Per-stage model override. Unset stages fall back to provider defaults. */
    models: z
      .object({
        triage: z.string().min(1).optional(),
        generate: z.string().min(1).optional(),
        verify: z.string().min(1).optional(),
        fallback_generate: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Extra request headers (auth proxies, gateway routing). */
    headers: z.record(z.string(), z.string()).optional(),
    /**
     * Force-override the capability flags for a self-hosted endpoint whose
     * OpenAI compatibility is partial.
     */
    tool_choice: z.boolean().optional(),
    max_tokens_field: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    temperature: z.boolean().optional(),
    /** Set only by `--save-key`. Fernet, machine-bound. */
    api_key_prefix: z.string().optional(),
    api_key_encrypted: z.string().optional(),
  })
  .strict();

export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

export type ConfigScope = "project" | "global";

// -----------------------------------------------------------------------------
// Read / write
// -----------------------------------------------------------------------------

function parseSettings(
  raw: unknown,
  origin: string,
): { settings: LlmSettings | null; error: string | null } {
  if (raw === undefined || raw === null) return { settings: null, error: null };
  const parsed = LlmSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "llm"}: ${i.message}`)
      .join("; ");
    return { settings: null, error: `Invalid \`llm\` config in ${origin} — ${issues}` };
  }
  return { settings: parsed.data, error: null };
}

export function readProjectLlmSettings(workingDir: string): {
  settings: LlmSettings | null;
  error: string | null;
} {
  try {
    if (!isInitialized(workingDir)) return { settings: null, error: null };
    return parseSettings(loadConfig(workingDir).llm, ".synapse/config.json");
  } catch {
    return { settings: null, error: null };
  }
}

export function readGlobalLlmSettings(): {
  settings: LlmSettings | null;
  error: string | null;
} {
  return parseSettings(loadGlobalConfig().llm, "~/.synapse/config.json");
}

export function writeLlmSettings(
  scope: ConfigScope,
  workingDir: string,
  settings: LlmSettings,
): void {
  const validated = LlmSettingsSchema.parse(settings);
  if (scope === "global") {
    const cfg = loadGlobalConfig();
    cfg.llm = validated;
    saveGlobalConfig(cfg);
    return;
  }
  if (!isInitialized(workingDir)) {
    throw new Error(
      "This directory isn't initialized. Run `synapse init` first, " +
        "or use `synapse model set <provider> --global`.",
    );
  }
  const cfg = loadConfig(workingDir);
  cfg.llm = validated;
  saveConfig(workingDir, cfg);
}

export function clearLlmSettings(scope: ConfigScope, workingDir: string): void {
  if (scope === "global") {
    const cfg = loadGlobalConfig();
    delete cfg.llm;
    saveGlobalConfig(cfg);
    return;
  }
  if (!isInitialized(workingDir)) return;
  const cfg = loadConfig(workingDir);
  delete cfg.llm;
  saveConfig(workingDir, cfg);
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** Per-invocation overrides from CLI flags. */
export interface LlmOverrides {
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Back-compat: `--anthropic-key` implies provider=anthropic. */
  anthropicKey?: string | null;
}

export interface ResolvedLlm {
  providerId: ProviderId;
  label: string;
  spec: ProviderSpec;
  baseUrl: string | null;
  apiKey: string | null;
  models: Record<Task, string>;
  caps: ProviderCaps;
  headers: Record<string, string>;
  /** Where the provider choice came from, for `synapse model` display. */
  source: "flag" | "env" | "project" | "global" | "default";
  /** Where the key came from. */
  keySource: "flag" | "env" | "stored" | "none";
  /** Blocking problems — empty means ready to run. */
  problems: string[];
  /** Non-blocking advisories. */
  warnings: string[];
}

function pickSettings(
  workingDir: string | undefined,
  warnings: string[],
): { settings: LlmSettings | null; source: "project" | "global" | "default" } {
  if (workingDir) {
    const project = readProjectLlmSettings(workingDir);
    if (project.error) warnings.push(project.error);
    if (project.settings) return { settings: project.settings, source: "project" };
  }
  const global = readGlobalLlmSettings();
  if (global.error) warnings.push(global.error);
  if (global.settings) return { settings: global.settings, source: "global" };
  return { settings: null, source: "default" };
}

/**
 * Precedence, highest first:
 *   1. CLI flags (--provider / --model / --base-url / --api-key, --anthropic-key)
 *   2. SYNAPSE_LLM_PROVIDER / SYNAPSE_LLM_MODEL / SYNAPSE_LLM_BASE_URL env
 *   3. project .synapse/config.json  → `llm`
 *   4. global  ~/.synapse/config.json → `llm`
 *   5. anthropic (unchanged default)
 */
export function resolveLlm(
  workingDir: string | undefined,
  overrides: LlmOverrides = {},
): ResolvedLlm {
  const warnings: string[] = [];
  const problems: string[] = [];

  const stored = pickSettings(workingDir, warnings);

  // --- provider ---
  const flagProvider = (overrides.provider ?? "").trim();
  const envProvider = (process.env.SYNAPSE_LLM_PROVIDER ?? "").trim();
  const anthropicKeyFlag = (overrides.anthropicKey ?? "").trim();

  let providerId: ProviderId = "anthropic";
  let source: ResolvedLlm["source"] = "default";

  if (flagProvider) {
    if (!isProviderId(flagProvider)) {
      problems.push(
        `Unknown provider "${flagProvider}". Known: ${PROVIDER_IDS.join(", ")}.`,
      );
    } else {
      providerId = flagProvider;
      source = "flag";
    }
  } else if (anthropicKeyFlag) {
    providerId = "anthropic";
    source = "flag";
  } else if (envProvider) {
    if (!isProviderId(envProvider)) {
      problems.push(
        `SYNAPSE_LLM_PROVIDER="${envProvider}" is not a known provider. ` +
          `Known: ${PROVIDER_IDS.join(", ")}.`,
      );
    } else {
      providerId = envProvider;
      source = "env";
    }
  } else if (stored.settings) {
    providerId = stored.settings.provider;
    source = stored.source === "default" ? "default" : stored.source;
  }

  const spec = PROVIDERS[providerId];
  // Stored per-stage models and caps only apply to the provider they were
  // saved for — otherwise switching provider via a flag would inherit the
  // previous provider's model ids.
  const applicable =
    stored.settings && stored.settings.provider === providerId
      ? stored.settings
      : null;

  // --- base URL ---
  const baseUrl =
    (overrides.baseUrl ?? "").trim() ||
    (process.env.SYNAPSE_LLM_BASE_URL ?? "").trim() ||
    applicable?.base_url ||
    spec.baseUrl;

  if (spec.kind === "openai-compat" && !baseUrl) {
    problems.push(
      `Provider "${providerId}" needs an endpoint. ` +
        `Run \`synapse model set ${providerId} --base-url <url> --model <id>\`.`,
    );
  }

  // --- models ---
  const flagModel = (overrides.model ?? "").trim();
  const envModel = (process.env.SYNAPSE_LLM_MODEL ?? "").trim();
  const singleModel = flagModel || envModel;

  const models = { ...spec.defaults } as Record<Task, string>;
  for (const task of TASKS) {
    const fromStore = applicable?.models?.[task];
    if (fromStore) models[task] = fromStore;
  }
  if (singleModel) {
    // A single --model pins every stage: the user asked for that model, and
    // silently keeping a different model for triage would be surprising.
    for (const task of TASKS) models[task] = singleModel;
  }

  const missingModels = TASKS.filter((t) => !models[t]);
  if (missingModels.length > 0) {
    problems.push(
      `No model configured for provider "${providerId}". ` +
        `Run \`synapse model set ${providerId} --model <id>\`.`,
    );
  }

  // --- key ---
  let apiKey: string | null = null;
  let keySource: ResolvedLlm["keySource"] = "none";

  const flagKey = (overrides.apiKey ?? "").trim() || anthropicKeyFlag;
  if (flagKey) {
    apiKey = flagKey;
    keySource = "flag";
  } else {
    const fromEnv = keyFromEnv(providerId);
    if (fromEnv) {
      apiKey = fromEnv;
      keySource = "env";
    } else if (applicable?.api_key_encrypted) {
      try {
        apiKey = decryptApiKey(applicable.api_key_encrypted);
        keySource = "stored";
      } catch (e) {
        warnings.push(
          `Stored ${spec.label} key could not be decrypted on this machine ` +
            `(${(e as Error).message.split("\n")[0]}). ` +
            `Re-run \`synapse model set ${providerId} --save-key <key>\`.`,
        );
      }
    }
  }

  if (!apiKey && spec.keyRequired) {
    problems.push(
      `${spec.label} API key required. Set ${spec.apiKeyEnv[0]}, ` +
        `or run \`synapse model set ${providerId} --save-key <key>\`. ` +
        `Keys: ${spec.docsUrl}`,
    );
  }

  // --- capability overrides (custom / partially-compatible endpoints) ---
  const caps: ProviderCaps = {
    toolChoice: applicable?.tool_choice ?? spec.caps.toolChoice,
    maxTokensField: applicable?.max_tokens_field ?? spec.caps.maxTokensField,
    temperature: applicable?.temperature ?? spec.caps.temperature,
    promptCache: spec.caps.promptCache,
  };

  return {
    providerId,
    label: spec.label,
    spec,
    baseUrl: baseUrl || null,
    apiKey,
    models,
    caps,
    headers: { ...(spec.headers ?? {}), ...(applicable?.headers ?? {}) },
    source,
    keySource,
    problems,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Display helpers for `synapse model`
// -----------------------------------------------------------------------------

export function llmKeyDisplay(resolved: ResolvedLlm): string {
  if (!resolved.apiKey) {
    return resolved.spec.keyRequired ? "(not set)" : "(not required)";
  }
  const prefix = resolved.apiKey.slice(0, 5);
  const label =
    resolved.keySource === "env"
      ? `env ${resolved.spec.apiKeyEnv.find((n) => (process.env[n] ?? "").trim()) ?? "env"}`
      : resolved.keySource;
  return `${formatApiKeyDisplay(prefix)} (${label})`;
}

export { encryptApiKey };
