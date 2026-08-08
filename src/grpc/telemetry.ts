import { sha256 } from "../utils/hash.js";
import { getApiUrl } from "../config/manager.js";
import { installationId } from "../backend/trace-forwarder.js";

function telemetryDisabled(): boolean {
  const v = process.env.SYNAPSE_TELEMETRY;
  return v === "0" || v === "false";
}

export interface QuotaInfo {
  mcpServersCount: number;
  maxMcpServers: number;
  linesIndexed: number;
  maxLinesIndexed: number;
  quotaExceeded: boolean;
  quotaMessage: string;
}

export async function trackEvent(
  eventType: string,
  apiKey: string,
  workingDir: string,
  linesCount = 0,
  toolCount = 0,
  candidateCount = 0,
  durationMs = 0,
  mode: "hosted" | "local" = "hosted",
): Promise<void> {
  try {
    if (telemetryDisabled()) return;
    // In hosted mode we require an API key so events are attributed. In local
    // mode we send anonymously via installation_id.
    if (mode === "hosted" && !apiKey) return;

    const apiUrl = getApiUrl();
    const workingDirHash = workingDir ? sha256(workingDir) : "";

    const payload: Record<string, unknown> = {
      event_type: eventType,
      working_dir_hash: workingDirHash,
      mode,
      installation_id: installationId(),
    };
    if (linesCount) payload.lines_count = linesCount;
    if (toolCount) payload.tool_count = toolCount;
    if (candidateCount) payload.candidate_count = candidateCount;
    if (durationMs) payload.duration_ms = durationMs;

    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    await fetch(`${apiUrl}/telemetry/cli`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {
    // Telemetry is fire-and-forget
  }
}

// ---------------------------------------------------------------------------
// REST-based quota functions (via api.synaps3.ai)
// ---------------------------------------------------------------------------

export async function checkQuota(
  apiKey: string,
): Promise<[boolean, string]> {
  try {
    if (telemetryDisabled()) return [false, ""];
    if (!apiKey) return [false, ""];

    const apiUrl = getApiUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const resp = await fetch(`${apiUrl}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) return [false, ""];

    const data = await resp.json();
    return [data.quota_exceeded ?? false, data.quota_message ?? ""];
  } catch {
    return [false, ""];
  }
}

export async function getQuotaInfo(
  apiKey: string,
): Promise<QuotaInfo | null> {
  try {
    if (telemetryDisabled()) return null;
    if (!apiKey) return null;

    const apiUrl = getApiUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(`${apiUrl}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) return null;

    const data = await resp.json();
    return {
      mcpServersCount: data.mcp_servers_count ?? 0,
      maxMcpServers: data.max_mcp_servers ?? 0,
      linesIndexed: data.lines_indexed ?? 0,
      maxLinesIndexed: data.max_lines_indexed ?? 0,
      quotaExceeded: data.quota_exceeded ?? false,
      quotaMessage: data.quota_message ?? "",
    };
  } catch {
    return null;
  }
}
