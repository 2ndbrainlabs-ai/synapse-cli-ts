import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GLOBAL_CONFIG_PATH,
  GLOBAL_SYNAPSE_DIR,
  getProjectConfigPath,
  getProjectSynapseDir,
} from "./paths.js";
import {
  decryptApiKey,
  encryptApiKey,
  formatApiKeyDisplay,
} from "./api-key-store.js";

export interface SynapseConfig {
  initialized?: boolean;
  version?: string;
  created_at?: string;
  last_updated?: string;
  api_key_prefix?: string;
  api_key_encrypted?: string;
  [key: string]: unknown;
}

export interface BackendConfig {
  url: string | null;
  host: string | null;
  port: string | null;
}

interface RootConfig {
  backend_url?: string;
  backend_host?: string;
  backend_port?: string;
  api_url?: string;
  version?: string;
}

let _rootConfig: RootConfig | null = null;

function loadRootConfig(): RootConfig {
  if (_rootConfig) return _rootConfig;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.resolve(__dirname, "../config.json");
    _rootConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    _rootConfig = {};
  }
  return _rootConfig!;
}

// --- Project config ---

export function loadConfig(workingDir: string): SynapseConfig {
  const configPath = getProjectConfigPath(workingDir);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      "Configuration not found. Please run 'synapse init' first.",
    );
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

export function saveConfig(workingDir: string, config: SynapseConfig): void {
  const synapseDir = getProjectSynapseDir(workingDir);
  const configPath = getProjectConfigPath(workingDir);
  fs.mkdirSync(synapseDir, { recursive: true });
  config.last_updated = new Date().toISOString();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function isInitialized(workingDir: string): boolean {
  return fs.existsSync(getProjectConfigPath(workingDir));
}

// --- Global config ---

export function ensureGlobalSynapseDir(): void {
  fs.mkdirSync(GLOBAL_SYNAPSE_DIR, { recursive: true });
}

export function ensureProjectSynapseDir(workingDir: string): void {
  fs.mkdirSync(getProjectSynapseDir(workingDir), { recursive: true });
}

export function loadGlobalConfig(): SynapseConfig {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveGlobalConfig(config: SynapseConfig): void {
  ensureGlobalSynapseDir();
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// --- API key storage ---

function getProjectApiKeyEncrypted(
  workingDir: string,
): [string | null, string | null] {
  try {
    const config = loadConfig(workingDir);
    const prefix = config.api_key_prefix ?? null;
    const encrypted = config.api_key_encrypted ?? null;
    if (prefix && encrypted) return [prefix, encrypted];
  } catch {
    // Not initialized
  }
  return [null, null];
}

function getGlobalApiKeyEncrypted(): [string | null, string | null] {
  const config = loadGlobalConfig();
  const prefix = config.api_key_prefix ?? null;
  const encrypted = config.api_key_encrypted ?? null;
  if (prefix && encrypted) return [prefix, encrypted];
  return [null, null];
}

export function setProjectApiKey(workingDir: string, rawKey: string): void {
  ensureProjectSynapseDir(workingDir);
  let config: SynapseConfig;
  if (isInitialized(workingDir)) {
    config = loadConfig(workingDir);
  } else {
    config = {
      initialized: true,
      version: "1.0.0",
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    };
  }
  const [prefix, encrypted] = encryptApiKey(rawKey);
  config.api_key_prefix = prefix;
  config.api_key_encrypted = encrypted;
  saveConfig(workingDir, config);
}

export function setGlobalApiKey(rawKey: string): void {
  ensureGlobalSynapseDir();
  const config = loadGlobalConfig();
  const [prefix, encrypted] = encryptApiKey(rawKey);
  config.api_key_prefix = prefix;
  config.api_key_encrypted = encrypted;
  saveGlobalConfig(config);
}

export function resolveApiKey(workingDir?: string): string | null {
  const envKey = (process.env.SYNAPSE_API_KEY ?? "").trim();
  if (envKey) return envKey;

  if (workingDir) {
    const [, encrypted] = getProjectApiKeyEncrypted(workingDir);
    if (encrypted) {
      try {
        return decryptApiKey(encrypted);
      } catch {
        // Fall through to global
      }
    }
  }

  const [, encrypted] = getGlobalApiKeyEncrypted();
  if (encrypted) {
    try {
      return decryptApiKey(encrypted);
    } catch {
      // Give up
    }
  }

  return null;
}

export function hasGlobalApiKey(): boolean {
  const [, enc] = getGlobalApiKeyEncrypted();
  return Boolean(enc);
}

export function hasProjectApiKey(workingDir: string): boolean {
  const [, enc] = getProjectApiKeyEncrypted(workingDir);
  return Boolean(enc);
}

export function getApiKeyDisplay(workingDir?: string): [string, string] {
  const [projectPrefix] = workingDir
    ? getProjectApiKeyEncrypted(workingDir)
    : [null, null];
  const [globalPrefix] = getGlobalApiKeyEncrypted();
  return [
    formatApiKeyDisplay(projectPrefix ?? ""),
    formatApiKeyDisplay(globalPrefix ?? ""),
  ];
}

// --- Backend config ---

export function getBackendConfig(): BackendConfig {
  const envUrl = (process.env.SYNAPSE_BACKEND_URL ?? "").trim();
  if (envUrl) {
    return { url: envUrl, host: null, port: null };
  }

  const cfg = loadRootConfig();
  const cfgUrl = (cfg.backend_url ?? "").trim();
  if (cfgUrl) {
    return { url: cfgUrl, host: null, port: null };
  }

  const host = (cfg.backend_host ?? "").trim();
  const port = (cfg.backend_port ?? "").trim();
  if (host) {
    return { url: null, host, port: port || "50051" };
  }

  return { url: null, host: "localhost", port: "50051" };
}

export function getApiUrl(): string {
  const envUrl = (process.env.SYNAPSE_API_URL ?? "").trim();
  if (envUrl) return envUrl;
  const cfg = loadRootConfig();
  return (cfg.api_url ?? "").trim() || "https://api.synaps3.ai";
}

export function getConfigDisplay(config: SynapseConfig): Array<[string, string]> {
  const backend = getBackendConfig();
  const backendStr = backend.url ?? `${backend.host}:${backend.port}`;
  return [
    ["Version", config.version ?? "Unknown"],
    ["Initialized", "Yes"],
    ["Created", config.created_at ?? "Unknown"],
    ["Last Updated", config.last_updated ?? "Unknown"],
    ["Backend", backendStr],
  ];
}
