// src/backend/ui-client.ts
//
// Thin fetch wrapper around synapse-ui-backend REST endpoints used by the
// Auto track of `synapse build --engine v2`.
//
// Calls:
//   POST /mcp-servers                      → create a server, get server_id
//   GET  /mcp-servers/{id}                 → does the bound server still exist? (404 = no)
//   PUT  /mcp-servers/{id}                 → refresh name/description on rebuild
//   GET  /mcp-servers/{id}/endpoints       → current endpoints, diffed on rebuild
//   POST /mcp-servers/{id}/endpoints/batch → attach new endpoints
//   PUT  /endpoints/{id}                   → update a changed endpoint in place
//   POST /endpoints/batch-delete           → drop endpoints no longer in the code
//
// All of these already exist on ui-backend, so a rebuild that reuses the
// server (SYN-285) works against any deployed backend.
//
// Auth: Bearer API key (same key resolved by config/manager.resolveApiKey).

import { getApiUrl, resolveApiKey } from "../config/manager.js";

export interface UiHeader {
  key: string;
  value: string;
}

export interface UiEndpointCreate {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "DELETE"; // ui-backend rejects PATCH
  url: string;
  headers: UiHeader[];
  payload: Record<string, unknown> | null;
  display_order?: number;
}

export interface CreateServerResponse {
  server: { id: string; name: string; description: string | null };
}

export interface BatchEndpointsResponse {
  endpoints: Array<{ id: string; name: string; method: string; url: string }>;
}

/** An endpoint as GET /mcp-servers/{id}/endpoints returns it. */
export interface UiEndpoint {
  id: string;
  name: string;
  description: string;
  method: string;
  url: string;
  headers: UiHeader[];
  payload: Record<string, unknown> | null;
  display_order: number;
}

/** PUT /endpoints/{id} body: only the fields that change. */
export type UiEndpointPatch = Partial<Omit<UiEndpointCreate, "payload">> & {
  payload?: Record<string, unknown>;
};

/** Thrown when the ui-backend returns a non-2xx response. */
export class UiBackendError extends Error {
  constructor(public status: number, public detail: string) {
    super(`ui-backend ${status}: ${detail}`);
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT",
  pathname: string,
  body: unknown,
  workingDir?: string,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const base = getApiUrl().replace(/\/+$/, "");
  const apiKey = resolveApiKey(workingDir);
  if (!apiKey) {
    throw new UiBackendError(401, "Missing API key. Run `synapse init` or set SYNAPSE_API_KEY.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(extraHeaders ?? {}),
  };
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text)?.detail ?? text;
    } catch {
      /* keep raw body */
    }
    throw new UiBackendError(res.status, String(detail));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function post<T>(
  pathname: string,
  body: unknown,
  workingDir?: string,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  return request<T>("POST", pathname, body, workingDir, extraHeaders);
}

export async function createMcpServer(opts: {
  name: string;
  description?: string;
  workingDir?: string;
}): Promise<CreateServerResponse> {
  return post<CreateServerResponse>(
    "/mcp-servers",
    { name: opts.name, description: opts.description ?? null },
    opts.workingDir,
  );
}

export async function batchCreateEndpoints(opts: {
  serverId: string;
  endpoints: UiEndpointCreate[];
  workingDir?: string;
  /** True when the SurfaceManifest was partial (interrupted by cap / sigint). */
  partial?: boolean;
}): Promise<BatchEndpointsResponse> {
  const headers = opts.partial ? { "X-Scan-Status": "partial" } : undefined;
  return post<BatchEndpointsResponse>(
    `/mcp-servers/${opts.serverId}/endpoints/batch`,
    { endpoints: opts.endpoints },
    opts.workingDir,
    headers,
  );
}

/** The server if this key's account still owns it, null if it is gone (404). */
export async function getMcpServer(opts: {
  serverId: string;
  workingDir?: string;
}): Promise<CreateServerResponse | null> {
  try {
    return await request<CreateServerResponse>(
      "GET",
      `/mcp-servers/${encodeURIComponent(opts.serverId)}`,
      undefined,
      opts.workingDir,
    );
  } catch (err) {
    // 404: deleted, or owned by another account. 400: not a valid id.
    if (err instanceof UiBackendError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

export async function updateMcpServer(opts: {
  serverId: string;
  name: string;
  description?: string;
  workingDir?: string;
}): Promise<CreateServerResponse> {
  return request<CreateServerResponse>(
    "PUT",
    `/mcp-servers/${encodeURIComponent(opts.serverId)}`,
    { name: opts.name, description: opts.description ?? null },
    opts.workingDir,
  );
}

export async function listEndpoints(opts: {
  serverId: string;
  workingDir?: string;
}): Promise<UiEndpoint[]> {
  const res = await request<{ endpoints?: UiEndpoint[] }>(
    "GET",
    `/mcp-servers/${encodeURIComponent(opts.serverId)}/endpoints`,
    undefined,
    opts.workingDir,
  );
  return res.endpoints ?? [];
}

export async function updateEndpoint(opts: {
  endpointId: string;
  patch: UiEndpointPatch;
  workingDir?: string;
}): Promise<void> {
  await request(
    "PUT",
    `/endpoints/${encodeURIComponent(opts.endpointId)}`,
    opts.patch,
    opts.workingDir,
  );
}

export async function deleteEndpoints(opts: {
  endpointIds: string[];
  workingDir?: string;
}): Promise<void> {
  if (opts.endpointIds.length === 0) return;
  await post("/endpoints/batch-delete", { endpoint_ids: opts.endpointIds }, opts.workingDir);
}
