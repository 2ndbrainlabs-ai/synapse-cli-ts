// src/backend/ui-client.ts
//
// Thin fetch wrapper around synapse-ui-backend REST endpoints used by the
// Auto track of `synapse build --engine v2`.
//
// Two calls today:
//   POST /mcp-servers                    → create a server, get server_id
//   POST /mcp-servers/{id}/endpoints/batch → attach the extracted endpoints
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

/** Thrown when the ui-backend returns a non-2xx response. */
export class UiBackendError extends Error {
  constructor(public status: number, public detail: string) {
    super(`ui-backend ${status}: ${detail}`);
  }
}

async function post<T>(
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
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(extraHeaders ?? {}),
  };
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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
