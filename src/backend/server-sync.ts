// src/backend/server-sync.ts
//
// Stable MCP server identity for hosted Auto builds (SYN-285).
//
// Before this, every `synapse build --auto` called POST /mcp-servers, so each
// rebuild minted a new server_id, used up one more MCP server of the user's
// quota and broke the SYNAPSE_SERVER_ID already pasted into their MCP client.
//
// Now the first build records the server it created in .synapse/config.json,
// keyed by API URL (DEV and PROD ids never mix) and server name (so
// `--server-name` gives a repo a second server on purpose). Later builds reuse
// that server and bring its endpoints in line with the code: new endpoints
// are added, changed ones updated in place, removed ones deleted. The server
// is created again only when it no longer exists for this key's account
// (deleted in the console, or a key for a different account), or when the
// user passes `--new`.

import {
  batchCreateEndpoints,
  createMcpServer,
  deleteEndpoints,
  getMcpServer,
  listEndpoints,
  updateEndpoint,
  updateMcpServer,
  type UiEndpoint,
  type UiEndpointCreate,
  type UiEndpointPatch,
  type UiHeader,
} from "./ui-client.js";
import { getApiUrl, isInitialized, loadConfig, saveConfig } from "../config/manager.js";

/** What a build did to the server: what the CLI prints and the caller reports. */
export type ServerAction = "created" | "updated" | "recreated";

export interface HostedServerBinding {
  id: string;
  created_at: string;
  updated_at: string;
}

/** .synapse/config.json → hosted_servers[apiUrl][serverName]. */
type BindingMap = Record<string, Record<string, HostedServerBinding>>;

function bindingScope(): string {
  return getApiUrl().trim().replace(/\/+$/, "");
}

export function readServerBinding(
  workingDir: string,
  serverName: string,
): HostedServerBinding | undefined {
  if (!isInitialized(workingDir)) return undefined;
  try {
    const map = loadConfig(workingDir).hosted_servers as BindingMap | undefined;
    const b = map?.[bindingScope()]?.[serverName];
    return b && typeof b.id === "string" && b.id ? b : undefined;
  } catch {
    return undefined;
  }
}

export function writeServerBinding(workingDir: string, serverName: string, serverId: string): void {
  // Auto builds require `synapse init`, so the config exists; if it somehow
  // doesn't, the build still succeeds — the next one just creates again.
  if (!isInitialized(workingDir)) return;
  try {
    const config = loadConfig(workingDir);
    const map = (config.hosted_servers as BindingMap | undefined) ?? {};
    const byName = map[bindingScope()] ?? {};
    const now = new Date().toISOString();
    const prev = byName[serverName];
    byName[serverName] = {
      id: serverId,
      created_at: prev?.id === serverId ? prev.created_at : now,
      updated_at: now,
    };
    map[bindingScope()] = byName;
    config.hosted_servers = map;
    saveConfig(workingDir, config);
  } catch {
    /* never fail a build over the local binding */
  }
}

// ---------------------------------------------------------------------------
// Endpoint diff
// ---------------------------------------------------------------------------

export interface EndpointSyncPlan {
  create: UiEndpointCreate[];
  update: Array<{ id: string; patch: UiEndpointPatch }>;
  remove: string[];
  unchanged: number;
}

/** An endpoint is the same endpoint when its method and URL template match. */
function endpointKey(e: { method: string; url: string }): string {
  return `${e.method.toUpperCase()} ${e.url}`;
}

function normHeaders(h: UiHeader[] | string | null | undefined): UiHeader[] {
  let list: unknown = h ?? [];
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  return Array.isArray(list)
    ? list.map((x) => ({ key: String(x?.key ?? ""), value: String(x?.value ?? "") }))
    : [];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Work out how to turn the server's current endpoints into `desired`.
 *
 * `partial` (the scan was cut short by the time cap or Ctrl-C): an endpoint
 * the scan didn't reach is not evidence that it was removed from the code, so
 * nothing is deleted.
 */
export function planEndpointSync(
  existing: UiEndpoint[],
  desired: UiEndpointCreate[],
  opts: { partial?: boolean } = {},
): EndpointSyncPlan {
  const pool = new Map<string, UiEndpoint[]>();
  for (const e of [...existing].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))) {
    const k = endpointKey(e);
    pool.set(k, [...(pool.get(k) ?? []), e]);
  }

  const plan: EndpointSyncPlan = { create: [], update: [], remove: [], unchanged: 0 };

  desired.forEach((want, order) => {
    const candidates = pool.get(endpointKey(want));
    const have = candidates?.shift();
    if (!have) {
      plan.create.push({ ...want, display_order: order });
      return;
    }
    // PUT /endpoints ignores a null payload, so a payload that has to go away
    // can only be dropped by replacing the endpoint.
    if (want.payload == null && have.payload != null) {
      plan.remove.push(have.id);
      plan.create.push({ ...want, display_order: order });
      return;
    }
    const patch: UiEndpointPatch = {};
    if (have.name !== want.name) patch.name = want.name;
    if (have.description !== want.description) patch.description = want.description;
    const headers = normHeaders(want.headers);
    if (!sameJson(normHeaders(have.headers), headers)) patch.headers = headers;
    if (want.payload != null && !sameJson(have.payload, want.payload)) patch.payload = want.payload;
    if ((have.display_order ?? 0) !== order) patch.display_order = order;
    if (Object.keys(patch).length === 0) plan.unchanged += 1;
    else plan.update.push({ id: have.id, patch });
  });

  if (!opts.partial) {
    for (const left of pool.values()) for (const e of left) plan.remove.push(e.id);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** Which step failed: picks the error box title in auto-flow. */
export class ServerPublishError extends Error {
  constructor(
    public readonly phase: "create" | "upload",
    public readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ServerPublishError";
  }
}

export interface PublishResult {
  serverId: string;
  action: ServerAction;
  /** The bound server that no longer exists (action === "recreated"). */
  previousServerId?: string;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface PublishOptions {
  workingDir: string;
  serverName: string;
  description: string;
  endpoints: UiEndpointCreate[];
  partial?: boolean;
  /** --new: create a fresh server even if this repo already has one. */
  forceNew?: boolean;
}

async function phase<T>(name: "create" | "upload", fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ServerPublishError(name, err);
  }
}

export async function publishServer(opts: PublishOptions): Promise<PublishResult> {
  const { workingDir, serverName, description, endpoints, partial } = opts;
  const bound = opts.forceNew ? undefined : readServerBinding(workingDir, serverName);

  if (bound) {
    const live = await phase("create", () => getMcpServer({ serverId: bound.id, workingDir }));
    if (live) {
      const serverId = bound.id;
      return phase("upload", async () => {
        // Also bumps updated_at and records a server_updated event.
        await updateMcpServer({ serverId, name: serverName, description, workingDir });
        const current = await listEndpoints({ serverId, workingDir });
        const plan = planEndpointSync(current, endpoints, { partial });
        // Add and update before deleting: if the run dies part way, the
        // server has an extra tool rather than a missing one, and the next
        // build finishes the job.
        if (plan.create.length > 0) {
          await batchCreateEndpoints({ serverId, endpoints: plan.create, workingDir, partial });
        }
        for (const u of plan.update) {
          await updateEndpoint({ endpointId: u.id, patch: u.patch, workingDir });
        }
        await deleteEndpoints({ endpointIds: plan.remove, workingDir });
        writeServerBinding(workingDir, serverName, serverId);
        return {
          serverId,
          action: "updated" as const,
          added: plan.create.length,
          updated: plan.update.length,
          removed: plan.remove.length,
          unchanged: plan.unchanged,
        };
      });
    }
  }

  const created = await phase("create", () =>
    createMcpServer({ name: serverName, description, workingDir }),
  );
  const serverId = created.server.id;
  // Bind before uploading endpoints: if the upload fails, the next build
  // fills in this server instead of creating yet another one.
  writeServerBinding(workingDir, serverName, serverId);
  await phase("upload", () =>
    batchCreateEndpoints({ serverId, endpoints, workingDir, partial }),
  );
  return {
    serverId,
    action: bound ? "recreated" : "created",
    previousServerId: bound?.id,
    added: endpoints.length,
    updated: 0,
    removed: 0,
    unchanged: 0,
  };
}
