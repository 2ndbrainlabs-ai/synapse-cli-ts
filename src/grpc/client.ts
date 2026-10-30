/**
 * gRPC Client for Synapse Backend API.
 *
 * Hosted-mode client for the v2 build: Custom-track code generation,
 * candidate classification and --smart-names endpoint naming. Each call
 * opens a Build bidi stream, sends one request and waits for one result.
 *
 * Ported from Python grpc_client/client.py. The Python version uses
 * grpc.aio (async generators); this version uses @grpc/grpc-js which
 * is callback/stream-based, wrapped in Promises for an async interface.
 */

import { resolveApiKey, getBackendConfig } from "../config/manager.js";

const MAX_MESSAGE_SIZE = 100 * 1024 * 1024; // 100MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse backend address, stripping protocol prefixes and defaulting
 * port to 443 when omitted.
 */
function parseTarget(address: string): { host: string; port: number } {
  let target = address
    .replace("https://", "")
    .replace("http://", "");

  if (target.includes(":")) {
    const idx = target.lastIndexOf(":");
    const host = target.slice(0, idx);
    const port = parseInt(target.slice(idx + 1), 10);
    return { host, port: Number.isNaN(port) ? 443 : port };
  }

  return { host: target, port: 443 };
}

/** Determine if a host/port pair should use TLS. */
function shouldUseSecure(host: string, port: number): boolean {
  if (port === 443) return true;
  if (host.endsWith(".run.app")) return true;
  if (host.endsWith(".cloudfunctions.net")) return true;
  return false;
}

/**
 * Generate a compact human-readable session id (`sess_<12chars>`).
 * Users can quote this when reporting issues; backend echoes it into
 * Langfuse traces and telemetry rows for cross-referencing.
 */
function _generateSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `sess_${ts}${rand}`;
}

/**
 * Standard channel options shared across all calls.
 *
 * Tuned for long-running agentic streams (classify / custom build).  The backend may
 * "think" for many minutes between messages — during those idle windows,
 * cloud load balancers and NATs will kill HTTP/2 streams unless we keep them
 * warm with pings.
 *
 * Key differences vs. defaults:
 *   - `keepalive_time_ms=20_000`      → ping every 20s (well under typical
 *                                        60s LB idle timeouts)
 *   - `keepalive_timeout_ms=15_000`   → wait 15s for ping ack before deeming
 *                                        the connection dead
 *   - `keepalive_permit_without_calls=1` → keep pinging during idle periods,
 *                                        not just active RPCs (default 0 = pings
 *                                        stop when no request in flight, which
 *                                        breaks long agent streams)
 *   - `max_pings_without_data=0`      → unlimited idle pings (default 2 would
 *                                        cap us early on quiet streams)
 *   - `min_time_between_pings_ms=10_000` → matches backend server tolerance
 *                                        (Synapse backend uses 10s min interval)
 *
 * No `deadline` is set — these RPCs must run for as long as the backend
 * agent needs.  Individual failures are recovered by the retry loop below.
 */
const CHANNEL_OPTIONS = {
  "grpc.max_send_message_length": MAX_MESSAGE_SIZE,
  "grpc.max_receive_message_length": MAX_MESSAGE_SIZE,
  "grpc.keepalive_time_ms": 20_000,
  "grpc.keepalive_timeout_ms": 15_000,
  "grpc.keepalive_permit_without_calls": 1,
  "grpc.http2.max_pings_without_data": 0,
  "grpc.http2.min_time_between_pings_ms": 10_000,
  "grpc.http2.min_ping_interval_without_data_ms": 10_000,
  // Retry the initial connection dance forever — cold Cloud Run instances
  // sometimes take 30-60s to warm up.
  "grpc.initial_reconnect_backoff_ms": 1_000,
  "grpc.max_reconnect_backoff_ms": 10_000,
  "grpc.enable_retries": 1,
} as const;

/**
 * Retryable gRPC status codes for stream reconnection.  These represent
 * transient network / infrastructure failures where re-issuing the RPC is
 * safe (we haven't yet received the terminal result).
 *
 * See https://grpc.github.io/grpc/core/md_doc_statuscodes.html.
 */
const RETRYABLE_GRPC_CODES = new Set<number>([
  4,  // DEADLINE_EXCEEDED
  8,  // RESOURCE_EXHAUSTED (rate limiting only; see isRetryableGrpcError)
  10, // ABORTED
  13, // INTERNAL
  14, // UNAVAILABLE
  15, // DATA_LOSS
]);

const RESOURCE_EXHAUSTED = 8;

/**
 * RESOURCE_EXHAUSTED details that mean a hard limit, not a burst: the
 * backend's quota rejections ("Lines quota exceeded (…)", "MCP server quota
 * exceeded (…)") and "Credits exhausted". Retrying these can't succeed, so
 * the CLI surfaces them at once. "Rate limit exceeded" is not matched and
 * keeps the backoff-and-retry behaviour.
 */
const HARD_LIMIT_RE = /quota|credit/i;

/**
 * Whether a gRPC stream error is worth re-issuing the RPC for (SYN-317).
 * RESOURCE_EXHAUSTED is retried only when it is rate limiting.
 */
export function isRetryableGrpcError(err: { code?: unknown; details?: unknown }): boolean {
  const code = typeof err.code === "number" ? err.code : undefined;
  if (code === undefined || !RETRYABLE_GRPC_CODES.has(code)) return false;
  if (code === RESOURCE_EXHAUSTED && HARD_LIMIT_RE.test(String(err.details ?? ""))) {
    return false;
  }
  return true;
}

/** Sleep helper for exponential backoff between reconnect attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// SynapseClient
// ---------------------------------------------------------------------------

export class SynapseClient {
  private host: string;
  private port: number;
  private workingDir: string;

  constructor(
    opts: {
      url?: string;
      host?: string;
      port?: number;
      workingDir?: string;
    } = {},
  ) {
    this.workingDir = opts.workingDir ?? process.cwd();

    // Resolve target address (precedence: explicit url > host/port > config)
    const backend = getBackendConfig();
    let address: string;

    if (opts.url) {
      address = opts.url;
    } else if (opts.host != null) {
      address = `${opts.host}:${opts.port ?? parseInt(backend.port || "443", 10)}`;
    } else {
      address = backend.url ?? `${backend.host}:${backend.port}`;
    }

    const parsed = parseTarget(address);
    this.host = parsed.host;
    this.port = parsed.port;
  }

  // -----------------------------------------------------------------------
  // buildCustom (v2 Custom track) — bidi stream: CLI sends ONE CustomToolRequest, backend replies with ONE
  // CustomToolResult (plus zero-or-more StatusUpdate frames in between).
  // No tool round-trips — backend does everything from the manifest.
  // -----------------------------------------------------------------------

  async buildCustom(opts: {
    language: string;
    manifestJson: string;
    intent: string;
    selectedQualnames?: string[];
    suggestedToolName?: string;
    sessionId?: string;
    onStatus?: (stage: string, message: string, progress: number) => void;
  }): Promise<{
    success: boolean;
    tool_name: string;
    file_extension: string;
    file_source: string;
    env_vars: string[];
    report_json: string;
    error: string;
    sessionId: string;
  }> {
    const grpc = await import("@grpc/grpc-js");
    const { loadProto } = await import("./proto-loader.js");
    const { SynapseService } = loadProto();

    const sessionId = opts.sessionId ?? _generateSessionId();

    const apiKey = resolveApiKey(this.workingDir);
    if (!apiKey) {
      return {
        success: false,
        tool_name: "",
        file_extension: "",
        file_source: "",
        env_vars: [],
        report_json: "",
        error: "Missing API key. Run `synapse init` or set SYNAPSE_API_KEY.",
        sessionId,
      };
    }

    const target = `${this.host}:${this.port}`;
    const credentials = shouldUseSecure(this.host, this.port)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const client = new SynapseService(target, credentials, CHANNEL_OPTIONS);
    const metadata = new grpc.Metadata();
    metadata.set("x-api-key", apiKey);

    return new Promise((resolve) => {
      const call = client.Build(metadata);

      let done = false;
      const finish = (result: any) => {
        if (done) return;
        done = true;
        try { call.end(); } catch { /* already closed */ }
        client.close();
        resolve({ ...result, sessionId });
      };

      call.write({
        custom_tool_request: {
          request_id: sessionId,
          language: opts.language,
          manifest_json: opts.manifestJson,
          intent: opts.intent,
          selected_qualnames: opts.selectedQualnames ?? [],
          suggested_tool_name: opts.suggestedToolName ?? "",
        },
      });

      call.on("data", (msg: any) => {
        if (msg.status_update) {
          const u = msg.status_update;
          opts.onStatus?.(u.stage ?? "", u.message ?? "", u.progress ?? 0);
        } else if (msg.custom_tool_result) {
          const r = msg.custom_tool_result;
          finish({
            success: !!r.success,
            tool_name: r.tool_name ?? "",
            file_extension: r.file_extension ?? "",
            file_source: r.file_source ?? "",
            env_vars: r.env_vars ?? [],
            report_json: r.report_json ?? "",
            error: r.error ?? "",
          });
        } else if (msg.error) {
          finish({
            success: false,
            tool_name: "",
            file_extension: "",
            file_source: "",
            env_vars: [],
            report_json: "",
            error: msg.error.message ?? "backend error",
          });
        }
      });

      call.on("end", () => {
        finish({
          success: false,
          tool_name: "",
          file_extension: "",
          file_source: "",
          env_vars: [],
          report_json: "",
          error: "stream ended before result",
        });
      });

      call.on("error", (err: any) => {
        finish({
          success: false,
          tool_name: "",
          file_extension: "",
          file_source: "",
          env_vars: [],
          report_json: "",
          error: `gRPC error: ${err.code ?? "UNKNOWN"}: ${err.details ?? err.message}`,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // classifyCandidates (v2 Custom-mode discovery) — one gRPC round-trip,
  // backend fans out N Haiku shards via asyncio.gather. Result is a JSON
  // list of {qualname, band, tool_shape, workflow_hints, one_line_purpose}.
  // -----------------------------------------------------------------------

  async classifyCandidates(opts: {
    manifestJson: string;
    shardSize?: number;
    maxShards?: number;
    sessionId?: string;
    signal?: AbortSignal;
    onStatus?: (stage: string, message: string, progress: number) => void;
    /** Client-side soft timeout in ms. Defaults to 60_000. Protects against
     *  a mismatched-version backend (no classify_request handler) hanging the
     *  CLI, or a Cloud Run cold start swallowing the request. */
    timeoutMs?: number;
  }): Promise<{
    success: boolean;
    verdicts: Array<Record<string, unknown>>;
    shards_run: number;
    cached_hits: number;
    budget_dropped: number;
    error: string;
    sessionId: string;
  }> {
    const grpc = await import("@grpc/grpc-js");
    const { loadProto } = await import("./proto-loader.js");
    const { SynapseService } = loadProto();

    const sessionId = opts.sessionId ?? _generateSessionId();

    const apiKey = resolveApiKey(this.workingDir);
    if (!apiKey) {
      return {
        success: false, verdicts: [], shards_run: 0, cached_hits: 0,
        budget_dropped: 0, error: "Missing API key.", sessionId,
      };
    }

    // Retry loop — mirrors nameEndpoints. Cold-start
    // UNAVAILABLE (code 14) is the top failure mode here, so retry up to
    // 3 times with exponential backoff before surfacing to the caller.
    const MAX_ATTEMPTS = 3;
    let lastResult: any = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      lastResult = await this._classifyOnce(grpc, SynapseService, apiKey, sessionId, opts);

      if (!lastResult.__transient) {
        const { __transient: _t, ...clean } = lastResult;
        return clean;
      }

      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        opts.onStatus?.(
          "retrying",
          `Backend cold-start — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
          0.1,
        );
        await sleep(backoff);
      }
    }

    const { __transient: _t, ...clean } = lastResult ?? {};
    return {
      ...clean,
      error: `Classifier failed after ${MAX_ATTEMPTS} attempts: ${lastResult?.error ?? "unknown"}`,
    };
  }

  private async _classifyOnce(
    grpc: typeof import("@grpc/grpc-js"),
    SynapseService: any,
    apiKey: string,
    sessionId: string,
    opts: {
      manifestJson: string;
      shardSize?: number;
      maxShards?: number;
      signal?: AbortSignal;
      onStatus?: (stage: string, message: string, progress: number) => void;
      timeoutMs?: number;
    },
  ): Promise<any> {
    const target = `${this.host}:${this.port}`;
    const credentials = shouldUseSecure(this.host, this.port)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const client = new SynapseService(target, credentials, CHANNEL_OPTIONS);
    const metadata = new grpc.Metadata();
    metadata.set("x-api-key", apiKey);

    const timeoutMs = opts.timeoutMs ?? 60_000;

    return new Promise((resolve) => {
      const call = client.Build(metadata);
      let done = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const finish = (payload: any) => {
        if (done) return;
        done = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        try { call.end(); } catch { /* already closed */ }
        client.close();
        resolve({ ...payload, sessionId });
      };

      // Soft timeout — if the backend doesn't respond, fall back gracefully.
      // Timeout is treated as transient (worth one retry).
      timeoutHandle = setTimeout(() => {
        finish({
          success: false, verdicts: [], shards_run: 0, cached_hits: 0,
          budget_dropped: 0, error: `timeout after ${timeoutMs}ms`,
          __transient: true,
        });
      }, timeoutMs);
      timeoutHandle.unref?.();

      const abortHandler = () => {
        finish({
          success: false, verdicts: [], shards_run: 0, cached_hits: 0,
          budget_dropped: 0, error: "aborted",
          __transient: false, // user aborted — don't retry
        });
      };
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      call.write({
        classify_request: {
          request_id: sessionId,
          manifest_json: opts.manifestJson,
          shard_size: opts.shardSize ?? 12,
          max_shards: opts.maxShards ?? 20,
        },
      });

      call.on("data", (msg: any) => {
        if (msg.status_update) {
          const u = msg.status_update;
          opts.onStatus?.(u.stage ?? "", u.message ?? "", u.progress ?? 0);
        } else if (msg.classify_result) {
          const r = msg.classify_result;
          let verdicts: Array<Record<string, unknown>> = [];
          try {
            verdicts = JSON.parse(r.verdicts_json || "[]");
          } catch { /* keep empty */ }
          finish({
            success: !!r.success,
            verdicts,
            shards_run: r.shards_run ?? 0,
            cached_hits: r.cached_hits ?? 0,
            budget_dropped: r.budget_dropped ?? 0,
            error: r.error ?? "",
            __transient: false,
          });
        } else if (msg.error) {
          finish({
            success: false, verdicts: [], shards_run: 0, cached_hits: 0,
            budget_dropped: 0, error: msg.error.message ?? "backend error",
            __transient: false,
          });
        }
      });

      call.on("end", () => {
        finish({
          success: false, verdicts: [], shards_run: 0, cached_hits: 0,
          budget_dropped: 0, error: "stream ended before result",
          __transient: true,
        });
      });
      call.on("error", (err: any) => {
        const transient = isRetryableGrpcError(err);
        finish({
          success: false, verdicts: [], shards_run: 0, cached_hits: 0,
          budget_dropped: 0,
          error: `gRPC error: ${err.code ?? "UNKNOWN"}: ${err.details ?? err.message}`,
          __transient: transient,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // nameEndpoints (v2 Auto-mode --smart-names, hosted) — CLI sends handler
  // source + repo readme context, backend runs the naming LLM call
  // server-side (billed/monetized) and returns tool_name + description per
  // endpoint. Same request/retry shape as classifyCandidates.
  // -----------------------------------------------------------------------

  async nameEndpoints(opts: {
    endpoints: Array<{
      index: number;
      method: string;
      path: string;
      handler_qualname: string;
      existing_description: string;
      handler_source: string;
    }>;
    workingDir: string;
    readmeContext?: string;
    sessionId?: string;
    signal?: AbortSignal;
    onStatus?: (stage: string, message: string, progress: number) => void;
    timeoutMs?: number;
  }): Promise<{
    success: boolean;
    names: Array<{ index: number; tool_name: string; description: string }>;
    error: string;
    sessionId: string;
  }> {
    const grpc = await import("@grpc/grpc-js");
    const { loadProto } = await import("./proto-loader.js");
    const { SynapseService } = loadProto();

    const sessionId = opts.sessionId ?? _generateSessionId();

    const apiKey = resolveApiKey(this.workingDir);
    if (!apiKey) {
      return { success: false, names: [], error: "Missing API key.", sessionId };
    }

    // 2 attempts, not 3 — see the timeout comment in _nameEndpointsOnce.
    // Worst case (backend never answers) this is ~24s total, not minutes.
    const MAX_ATTEMPTS = 2;
    let lastResult: any = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      lastResult = await this._nameEndpointsOnce(grpc, SynapseService, apiKey, sessionId, opts);

      if (!lastResult.__transient) {
        const { __transient: _t, ...clean } = lastResult;
        return clean;
      }

      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        opts.onStatus?.(
          "retrying",
          `Backend cold-start — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
          0.1,
        );
        await sleep(backoff);
      }
    }

    const { __transient: _t, ...clean } = lastResult ?? {};
    return {
      ...clean,
      error: `Namer failed after ${MAX_ATTEMPTS} attempts: ${lastResult?.error ?? "unknown"}`,
    };
  }

  private async _nameEndpointsOnce(
    grpc: typeof import("@grpc/grpc-js"),
    SynapseService: any,
    apiKey: string,
    sessionId: string,
    opts: {
      endpoints: Array<{
        index: number;
        method: string;
        path: string;
        handler_qualname: string;
        existing_description: string;
        handler_source: string;
      }>;
      readmeContext?: string;
      signal?: AbortSignal;
      onStatus?: (stage: string, message: string, progress: number) => void;
      timeoutMs?: number;
    },
  ): Promise<any> {
    const target = `${this.host}:${this.port}`;
    const credentials = shouldUseSecure(this.host, this.port)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const client = new SynapseService(target, credentials, CHANNEL_OPTIONS);
    const metadata = new grpc.Metadata();
    metadata.set("x-api-key", apiKey);

    // A single small, forced-tool-use Haiku call over 1-30 endpoints should
    // resolve in a couple of seconds. This is intentionally much tighter
    // than classifyCandidates' 60s (which can legitimately run several
    // Haiku shards) — if the backend doesn't recognize name_request at all
    // (e.g. not deployed yet), we want to fail fast and fall back to
    // mechanical names, not sit for a minute per attempt.
    const timeoutMs = opts.timeoutMs ?? 12_000;

    return new Promise((resolve) => {
      const call = client.Build(metadata);
      let done = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const finish = (payload: any) => {
        if (done) return;
        done = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        try { call.end(); } catch { /* already closed */ }
        client.close();
        resolve({ ...payload, sessionId });
      };

      timeoutHandle = setTimeout(() => {
        finish({ success: false, names: [], error: `timeout after ${timeoutMs}ms`, __transient: true });
      }, timeoutMs);
      timeoutHandle.unref?.();

      const abortHandler = () => {
        finish({ success: false, names: [], error: "aborted", __transient: false });
      };
      opts.signal?.addEventListener("abort", abortHandler, { once: true });

      call.write({
        name_request: {
          request_id: sessionId,
          endpoints: opts.endpoints,
          readme_context: opts.readmeContext ?? "",
        },
      });

      call.on("data", (msg: any) => {
        if (msg.status_update) {
          const u = msg.status_update;
          opts.onStatus?.(u.stage ?? "", u.message ?? "", u.progress ?? 0);
        } else if (msg.name_result) {
          const r = msg.name_result;
          let names: Array<{ index: number; tool_name: string; description: string }> = [];
          try {
            names = JSON.parse(r.names_json || "[]");
          } catch { /* keep empty */ }
          finish({ success: !!r.success, names, error: r.error ?? "", __transient: false });
        } else if (msg.error) {
          finish({
            success: false, names: [], error: msg.error.message ?? "backend error",
            __transient: false,
          });
        }
      });

      call.on("end", () => {
        finish({ success: false, names: [], error: "stream ended before result", __transient: true });
      });
      call.on("error", (err: any) => {
        const transient = isRetryableGrpcError(err);
        finish({
          success: false, names: [],
          error: `gRPC error: ${err.code ?? "UNKNOWN"}: ${err.details ?? err.message}`,
          __transient: transient,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // Close (no-op convenience — each RPC creates its own client above)
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    // Individual RPCs create and close their own gRPC clients, so there
    // is nothing persistent to tear down here.  The method exists for
    // API compatibility with the Python SynapseClient.
  }
}
