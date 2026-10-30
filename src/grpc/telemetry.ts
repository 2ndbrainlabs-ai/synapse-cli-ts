import { sha256 } from "../utils/hash.js";
import { getApiUrl } from "../config/manager.js";
import { installationId } from "../backend/trace-forwarder.js";
import { readCliVersion, UNKNOWN_CLI_VERSION } from "../utils/version.js";

// SYNAPSE_TELEMETRY=0 opts out of ANALYTICS events only (init, build, ...).
// It does not turn off quota enforcement (SYN-315): checkQuota/getQuotaInfo
// always run, and the hosted `analyze` line-count event is still sent because
// it is the accounting record the lines-indexed quota is charged from, not
// analytics. When telemetry is off that event carries only what the server
// needs to charge the quota: event_type, lines_count and mode (no hashes,
// installation id or CLI version).
function telemetryDisabled(): boolean {
  const v = process.env.SYNAPSE_TELEMETRY;
  return v === "0" || v === "false";
}

/** Outcome of a /telemetry/cli POST. Never thrown — callers branch on it. */
export interface TrackResult {
  /** True only for a 2xx response. */
  ok: boolean;
  /** HTTP status, or 0 when nothing was sent (skipped, timeout, network error). */
  status: number;
  /** Server `detail` message on an error response, when there is one. */
  detail?: string;
}

const NOT_SENT: TrackResult = { ok: false, status: 0 };

/** The hosted `analyze` event with a positive line count charges the quota. */
function isQuotaAccountingEvent(
  eventType: string,
  linesCount: number,
  mode: "hosted" | "local",
): boolean {
  return eventType === "analyze" && linesCount > 0 && mode === "hosted";
}

/**
 * True when a /telemetry/cli response means the lines-indexed quota is used
 * up. ui-backend (routers/telemetry.py) answers 429 for two reasons and sends
 * no structured code, only `detail`:
 *   - quota:      "Lines analyzed quota exceeded. ..." (detail mentions the quota;
 *                 the trailing contact text varies by server version)
 *   - rate limit: "Rate limit exceeded"
 * Only a 429 whose detail mentions the quota blocks. A rate limit, or a 429
 * with no readable detail (e.g. from a proxy or load balancer), is treated as
 * transient and fails open; the pre-flight GET /quota still blocks a user who
 * is over the limit.
 */
export function isQuotaExceeded(result: TrackResult): boolean {
  if (result.status !== 429) return false;
  const detail = result.detail ?? "";
  return /\bquota\b/i.test(detail) && !/rate[\s_-]*limit/i.test(detail);
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
): Promise<TrackResult> {
  try {
    const accounting = isQuotaAccountingEvent(eventType, linesCount, mode);
    const analyticsOff = telemetryDisabled();
    // Opted out: skip everything except the quota accounting event.
    if (analyticsOff && !accounting) return NOT_SENT;
    // In hosted mode we require an API key so events are attributed. In local
    // mode we send anonymously via installation_id.
    if (mode === "hosted" && !apiKey) return NOT_SENT;

    const apiUrl = getApiUrl();

    let payload: Record<string, unknown>;
    if (analyticsOff) {
      // Minimal accounting record — see the note on telemetryDisabled().
      payload = { event_type: eventType, lines_count: linesCount, mode };
    } else {
      payload = {
        event_type: eventType,
        working_dir_hash: workingDir ? sha256(workingDir) : "",
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
    }

    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const resp = await fetch(`${apiUrl}/telemetry/cli`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (resp.ok) return { ok: true, status: resp.status };
    return { ok: false, status: resp.status, detail: await readDetail(resp) };
  } catch {
    // Never throws: a timeout or network error is reported as "not sent".
    return NOT_SENT;
  }
}

async function readDetail(resp: Response): Promise<string | undefined> {
  try {
    const data = (await resp.json()) as { detail?: unknown };
    return typeof data.detail === "string" ? data.detail : undefined;
  } catch {
    return undefined;
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
    // Runs even with SYNAPSE_TELEMETRY=0: the quota is enforcement, not analytics.
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
    // Runs even with SYNAPSE_TELEMETRY=0, like checkQuota.
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
