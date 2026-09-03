// src/providers/index.ts
//
// Provider construction. Takes an already-resolved configuration (see
// config/llm-config.ts) and returns the LlmProvider the backend talks to.
//
// Deliberately structural rather than importing ResolvedLlm: config/ depends on
// providers/catalog, so a type import the other way would close a cycle.

import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { ProviderCaps } from "./catalog.js";
import type { LlmProvider, ProviderId, Task } from "./types.js";

export interface ProviderInit {
  providerId: ProviderId;
  label: string;
  kind: "anthropic" | "openai-compat";
  baseUrl: string | null;
  apiKey: string | null;
  models: Record<Task, string>;
  caps: ProviderCaps;
  headers: Record<string, string>;
}

export function createProvider(init: ProviderInit): LlmProvider {
  if (init.kind === "anthropic") {
    if (!init.apiKey) {
      throw new Error("Anthropic provider requires an API key.");
    }
    return new AnthropicProvider({
      apiKey: init.apiKey,
      baseUrl: init.baseUrl,
      models: init.models,
    });
  }

  if (!init.baseUrl) {
    throw new Error(
      `Provider "${init.providerId}" requires a base URL. ` +
        `Run \`synapse model set ${init.providerId} --base-url <url>\`.`,
    );
  }

  return new OpenAICompatProvider({
    id: init.providerId,
    label: init.label,
    baseUrl: init.baseUrl,
    apiKey: init.apiKey,
    caps: init.caps,
    models: init.models,
    headers: init.headers,
  });
}

export type { LlmProvider, ProviderId, Task } from "./types.js";
export { LlmError } from "./types.js";
export { PROVIDERS, PROVIDER_IDS, isProviderId, keyFromEnv } from "./catalog.js";
export type { ProviderSpec, ProviderCaps } from "./catalog.js";
