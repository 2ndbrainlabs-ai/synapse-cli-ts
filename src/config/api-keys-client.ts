// REST client for the Synapse API key endpoints (`synapse config keys|revoke`).
//
// The API accepts a Synapse API key as the bearer credential on /api-keys, so
// the CLI can list and revoke the keys of the account its key belongs to.
// Revocation (DELETE /api-keys/{id}) deactivates the key in the database;
// the gRPC backend picks that up within ~30 s for signed keys (SYN-182).

import { getApiUrl } from "./manager.js";

export interface ApiKeyInfo {
  id: string;
  /** First characters of the key, for humans. Never the whole key. */
  keyPrefix: string;
  name: string;
  createdAt: string | null;
  lastUsed: string | null;
  expiresAt: string | null;
}

/** A request that failed; `status` is the HTTP status, 0 when unreachable. */
export class ApiKeysError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiKeysError";
  }
}

const TIMEOUT_MS = 30_000; // covers an API cold start (SYN-321)

async function request(apiKey: string, method: string, path: string): Promise<unknown> {
  const url = `${getApiUrl().replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch {
    throw new ApiKeysError("Couldn't reach Synapse. Check your connection and try again.", 0);
  } finally {
    clearTimeout(timer);
  }

  if (resp.ok) return resp.json().catch(() => ({}));

  let detail = "";
  try {
    const body = (await resp.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    /* no JSON body */
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new ApiKeysError("Synapse rejected the API key in use. It may be invalid, expired or revoked.", resp.status);
  }
  if (resp.status === 404) {
    throw new ApiKeysError(detail || "API key not found on this account.", 404);
  }
  if (resp.status === 400) {
    throw new ApiKeysError(detail || "Invalid API key id.", 400);
  }
  throw new ApiKeysError(detail || `Synapse returned HTTP ${resp.status}.`, resp.status);
}

/** Active (not revoked) keys of the account that owns `apiKey`. */
export async function listApiKeys(apiKey: string): Promise<ApiKeyInfo[]> {
  const body = (await request(apiKey, "GET", "/api-keys")) as {
    api_keys?: Array<Record<string, unknown>>;
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return (body.api_keys ?? []).map((k) => ({
    id: String(k.id ?? ""),
    keyPrefix: String(k.key_prefix ?? ""),
    name: String(k.name ?? ""),
    createdAt: str(k.created_at),
    lastUsed: str(k.last_used),
    expiresAt: str(k.expires_at),
  }));
}

/** Revoke one key of the account that owns `apiKey`. */
export async function revokeApiKey(apiKey: string, keyId: string): Promise<void> {
  await request(apiKey, "DELETE", `/api-keys/${encodeURIComponent(keyId)}`);
}

/**
 * The `api_key_id` embedded in a signed key (`syn_live_<kid>.<payload>.<sig>`),
 * or null for a legacy key. Decodes without verifying — only used to find
 * which listed key is the one in use, never to trust the key.
 */
export function signedKeyId(rawKey: string): string | null {
  if (!rawKey.startsWith("syn_live_")) return null;
  const parts = rawKey.slice("syn_live_".length).split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as {
      api_key_id?: unknown;
    };
    return typeof claims.api_key_id === "string" ? claims.api_key_id : null;
  } catch {
    return null;
  }
}

/**
 * Which of `keys` is `rawKey`. Signed keys carry their id; a legacy key is
 * matched on its stored prefix, which is unique in practice (10 random
 * characters after `syn-api-`).
 */
export function findKeyInUse(rawKey: string, keys: ApiKeyInfo[]): ApiKeyInfo | null {
  const id = signedKeyId(rawKey);
  if (id) return keys.find((k) => k.id === id) ?? null;
  if (rawKey.startsWith("syn_live_")) return null;
  const matches = keys.filter((k) => k.keyPrefix.length >= 12 && rawKey.startsWith(k.keyPrefix));
  return matches.length === 1 ? matches[0] : null;
}
