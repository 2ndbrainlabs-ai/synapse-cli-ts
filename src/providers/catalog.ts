// src/providers/catalog.ts
//
// Per-provider transport facts: where to POST, which env var holds the key,
// which model to use per pipeline stage, and the handful of places providers
// diverge from OpenAI's chat-completions contract.
//
// Model ids are DEFAULTS ONLY and are never validated client-side. Provider
// catalogues churn fast (Groq retired the Kimi and Llama-4-Scout ids during
// 2026; xAI redirects whole grok-3/grok-4-fast families), so a hardcoded
// allowlist would reject valid models and need a CLI release to fix. If a model
// id is wrong the provider says so, and `synapse model set <provider> --model`
// overrides it without waiting for us.

import type { ProviderId, Task } from "./types.js";

export interface ProviderCaps {
  /**
   * Provider honours `tool_choice` to force one named function.
   * Ollama explicitly does not, so its adapter falls back to JSON mode.
   */
  toolChoice: boolean;
  /**
   * Output-cap field name. OpenAI deprecated `max_tokens` for
   * `max_completion_tokens` and rejects the old name on reasoning models;
   * `max_completion_tokens` is accepted by their non-reasoning models too,
   * so it is the safe choice for that provider.
   */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /**
   * Provider accepts `temperature`. OpenAI reasoning models (gpt-5, o-series)
   * reject it outright, so we omit it there rather than guess per model.
   */
  temperature: boolean;
  /** Native prompt caching for stable system prefixes. */
  promptCache: boolean;
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  kind: "anthropic" | "openai-compat";
  /** Default endpoint root. `null` means the user must supply one. */
  baseUrl: string | null;
  /** Env vars checked in order for the key. */
  apiKeyEnv: string[];
  /** Ollama accepts any key and ignores it, so we don't demand one. */
  keyRequired: boolean;
  /** Where to get a key / which model ids are valid. */
  docsUrl: string;
  defaults: Record<Task, string>;
  caps: ProviderCaps;
  /** Static extra headers (OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Shown after `synapse model set` when the provider needs a caveat. */
  note?: string;
}

const OPENAI_COMPAT_CAPS: ProviderCaps = {
  toolChoice: true,
  maxTokensField: "max_tokens",
  temperature: true,
  promptCache: false,
};

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: null, // SDK default
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    keyRequired: true,
    docsUrl: "https://console.anthropic.com/settings/keys",
    defaults: {
      triage: "claude-haiku-4-5-20251001",
      generate: "claude-sonnet-4-5-20250929",
      verify: "claude-sonnet-4-5-20250929",
      fallback_generate: "claude-haiku-4-5-20251001",
    },
    caps: {
      toolChoice: true,
      maxTokensField: "max_tokens",
      temperature: true,
      promptCache: true,
    },
  },

  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    keyRequired: true,
    docsUrl: "https://platform.openai.com/docs/models",
    defaults: {
      triage: "gpt-5-mini",
      generate: "gpt-5",
      verify: "gpt-5",
      fallback_generate: "gpt-5-mini",
    },
    caps: {
      toolChoice: true,
      maxTokensField: "max_completion_tokens",
      temperature: false,
      promptCache: false,
    },
  },

  groq: {
    id: "groq",
    label: "Groq",
    kind: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    keyRequired: true,
    docsUrl: "https://console.groq.com/docs/models",
    defaults: {
      triage: "llama-3.1-8b-instant",
      generate: "openai/gpt-oss-120b",
      verify: "openai/gpt-oss-120b",
      fallback_generate: "llama-3.1-8b-instant",
    },
    caps: OPENAI_COMPAT_CAPS,
  },

  grok: {
    id: "grok",
    label: "xAI (Grok)",
    kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: ["XAI_API_KEY", "GROK_API_KEY"],
    keyRequired: true,
    docsUrl: "https://docs.x.ai/docs/models",
    // xAI model ids are dotted (grok-4.6), not hyphenated.
    defaults: {
      triage: "grok-4.5",
      generate: "grok-4.6",
      verify: "grok-4.6",
      fallback_generate: "grok-4.5",
    },
    caps: OPENAI_COMPAT_CAPS,
  },

  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    keyRequired: true,
    docsUrl: "https://openrouter.ai/models",
    defaults: {
      triage: "anthropic/claude-haiku-4.5",
      generate: "anthropic/claude-sonnet-4.5",
      verify: "anthropic/claude-sonnet-4.5",
      fallback_generate: "anthropic/claude-haiku-4.5",
    },
    caps: OPENAI_COMPAT_CAPS,
    headers: {
      "HTTP-Referer": "https://synaps3.ai",
      "X-Title": "Synapse CLI",
    },
  },

  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: ["OLLAMA_API_KEY"],
    keyRequired: false,
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
    defaults: {
      triage: "llama3.1:8b",
      generate: "qwen3-coder:30b",
      verify: "qwen3-coder:30b",
      fallback_generate: "llama3.1:8b",
    },
    caps: {
      // Ollama documents tool_choice as unsupported — the adapter coerces
      // structured output via JSON mode instead.
      toolChoice: false,
      maxTokensField: "max_tokens",
      temperature: true,
      promptCache: false,
    },
    note:
      "Ollama ignores tool_choice, so Synapse coerces JSON output instead. " +
      "Codegen needs a tool-capable model — pull one first (e.g. " +
      "`ollama pull qwen3-coder:30b`). Small models often fail the strict schema.",
  },

  custom: {
    id: "custom",
    label: "Custom endpoint",
    kind: "openai-compat",
    baseUrl: null, // user must supply --base-url
    apiKeyEnv: ["SYNAPSE_LLM_API_KEY"],
    keyRequired: false,
    docsUrl: "https://github.com/2ndbrainlabs-ai/synapse-cli",
    defaults: {
      triage: "",
      generate: "",
      verify: "",
      fallback_generate: "",
    },
    caps: OPENAI_COMPAT_CAPS,
    note:
      "Custom endpoints must expose POST {base_url}/chat/completions with the " +
      "OpenAI request/response shape. If yours ignores tool_choice, set " +
      "--no-tool-choice so Synapse coerces JSON output instead.",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(v: string): v is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

/** Env var that holds a key for this provider, if any is set. */
export function keyFromEnv(id: ProviderId): string | null {
  for (const name of PROVIDERS[id].apiKeyEnv) {
    const v = (process.env[name] ?? "").trim();
    if (v) return v;
  }
  const generic = (process.env.SYNAPSE_LLM_API_KEY ?? "").trim();
  return generic || null;
}
