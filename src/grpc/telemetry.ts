import { sha256 } from "../utils/hash.js";
import { getApiUrl } from "../config/manager.js";
import { installationId } from "../backend/trace-forwarder.js";
import { readCliVersion, UNKNOWN_CLI_VERSION } from "../utils/version.js";

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

/**
 * Outcome fields for a `build` event (SYN-314). Older ui-backends ignore
 * fields they don't know (pydantic's default extra="ignore"), so sending them
 * never breaks ingestion.
 */
export interface EventOutcome {
  /** false for a failed or aborted build. */
  success?: boolean;
  /** Why the build failed or was aborted — set only when success is false. */
  errorCode?: string;
  /** Detected project language, e.g. "python". */
  language?: string;
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
  outcome: EventOutcome = {},
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
    if (durationMs) payload.duration_ms = Math.round(durationMs);
    if (outcome.success !== undefined) payload.success = outcome.success;
    if (outcome.errorCode && outcome.success === false) payload.error_code = outcome.errorCode;
    if (outcome.language) payload.language = outcome.language;
    const cliVersion = readCliVersion();
    if (cliVersion !== UNKNOWN_CLI_VERSION) payload.cli_version = cliVersion;

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
// API key check — used by `synapse init` (SYN-314). Not telemetry, so it runs
// even with SYNAPSE_TELEMETRY=0. Anything other than a clear accept/reject
// (offline, timeout, 5xx) is "unknown" and must never block the caller.
//
// A Cloud Run cold start on the API takes ~14 s (SYN-321), longer than a
// normal request should, so a timeout or network error on the first attempt
// is retried once with a longer timeout — ~30 s in all. `onRetry` lets the
// caller tell the user why init is waiting.
// ---------------------------------------------------------------------------

export type ApiKeyCheck = "valid" | "rejected" | "unknown";

export interface VerifyApiKeyOptions {
  /** Timeout for the first attempt. */
  timeoutMs?: number;
  /** Timeout for the single retry after a timeout or network error. */
  retryTimeoutMs?: number;
  /** Called once, just before the retry. */
  onRetry?: () => void;
}

type KeyAttempt = ApiKeyCheck | "unreachable";

async function checkKeyOnce(apiKey: string, timeoutMs: number): Promise<KeyAttempt> {
  try {
    const apiUrl = getApiUrl().replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${apiUrl}/quota`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (resp.ok) return "valid";
    if (resp.status === 401 || resp.status === 403) return "rejected";
    return "unknown";
  } catch {
    // Timeout (abort) or network error — the API may still be starting up.
    return "unreachable";
  }
}

export async function verifyApiKey(
  apiKey: string,
  opts: VerifyApiKeyOptions = {},
): Promise<ApiKeyCheck> {
  if (!apiKey) return "rejected";
  const { timeoutMs = 10_000, retryTimeoutMs = 20_000, onRetry } = opts;
  const first = await checkKeyOnce(apiKey, timeoutMs);
  if (first !== "unreachable") return first;
  try {
    onRetry?.();
  } catch {
    // A status callback must never break the check.
  }
  const second = await checkKeyOnce(apiKey, retryTimeoutMs);
  return second === "unreachable" ? "unknown" : second;
}

// ---------------------------------------------------------------------------
// REST-based quota functions (via api.synapse.2ndbrainlabs.ai)
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
