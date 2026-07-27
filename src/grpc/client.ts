/**
 * gRPC Client for Synapse Backend API.
 *
 * Implements bidirectional streaming communication with the backend
 * for build workflows and unary RPCs for endpoint detection.
 *
 * Ported from Python grpc_client/client.py. The Python version uses
 * grpc.aio (async generators); this version uses @grpc/grpc-js which
 * is callback/stream-based, wrapped in Promises for an async interface.
 */

import { resolveApiKey, getBackendConfig } from "../config/manager.js";
import { ToolExecutor, type ToolResult } from "./tool-executor.js";

const MAX_MESSAGE_SIZE = 100 * 1024 * 1024; // 100MB

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BuildCallbacks {
  onStatus?: (stage: string, message: string, progress: number) => void;
  onToolCall?: (toolName: string, result: ToolResult) => void;
}

export interface BuildResult {
  success: boolean;
  serverCode?: string;
  toolCount?: number;
  resourceCount?: number;
  documentation?: string;
  todoList?: string;
  error?: string;
  errorCode?: string;
}

export interface DetectResult {
  candidates: Array<{
    name: string;
    file_path: string;
    confidence: number;
    human_title: string;
    human_description: string;
    conversion_type: string;
    client_dependency_json: string;
    subcategory: string;
    signature: string;
    docstring: string;
    line_number: number;
  }>;
  error: string;
}

export interface UseCase {
  title: string;
  description: string;
  functions: string[];
  module: string;
}

export interface DiscoverResult {
  useCases: UseCase[];
  error: string;
}

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
 * Tuned for long-running agentic streams (discover / build).  The backend may
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
 * safe (we haven't yet received the terminal `build_result`).
 *
 * See https://grpc.github.io/grpc/core/md_doc_statuscodes.html.
 */
const RETRYABLE_GRPC_CODES = new Set<number>([
  4,  // DEADLINE_EXCEEDED
  8,  // RESOURCE_EXHAUSTED
  10, // ABORTED
  13, // INTERNAL
  14, // UNAVAILABLE
  15, // DATA_LOSS
]);

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
  private toolExecutor: ToolExecutor;

  constructor(
    opts: {
      url?: string;
      host?: string;
      port?: number;
      workingDir?: string;
    } = {},
  ) {
    this.workingDir = opts.workingDir ?? process.cwd();
    this.toolExecutor = new ToolExecutor(this.workingDir);

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
  // DetectEndpoints — unary RPC
  // -----------------------------------------------------------------------

  async detect(
    functions: Record<string, unknown>[],
    workingDir: string,
    projectSchema = "",
    onBatch?: (info: { candidates: number; classified: number; total: number }) => void,
  ): Promise<DetectResult> {
    const grpc = await import("@grpc/grpc-js");
    const { loadProto } = await import("./proto-loader.js");
    const { SynapseService } = loadProto();

    const target = `${this.host}:${this.port}`;
    const credentials = shouldUseSecure(this.host, this.port)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const client = new SynapseService(target, credentials, CHANNEL_OPTIONS);

    const apiKey = resolveApiKey(this.workingDir);
    if (!apiKey) {
      client.close();
      return {
        candidates: [],
        error:
          "Missing API key. Set one with: synapse init, synapse config --key <KEY>, " +
          "or set SYNAPSE_API_KEY in the environment.",
      };
    }

    const metadata = new grpc.Metadata();
    metadata.set("x-api-key", apiKey);

    // Build FunctionInfo proto messages
    const fnProtos = functions.map((fn) => ({
      name: (fn.name as string) ?? "",
      file_path: ((fn.file_path ?? fn.filePath) as string) ?? "",
      signature: (fn.signature as string) ?? "",
      docstring: (fn.docstring as string) ?? "",
      return_type: ((fn.return_type ?? fn.returnType) as string) ?? "",
      is_async: Boolean(fn.is_async ?? fn.isAsync ?? false),
      line_number: Number(fn.line_number ?? fn.lineNumber ?? 0),
      param_names: (fn.param_names ?? fn.paramNames ?? []) as string[],
      param_types: (fn.param_types ?? fn.paramTypes ?? []) as string[],
      endpoint_type: ((fn.endpoint_type ?? fn.endpointType) as string) ?? "function",
    }));

    const request = {
      working_dir: workingDir,
      functions: fnProtos,
      project_schema: projectSchema,
    };

    return new Promise<DetectResult>((resolve) => {
      const allCandidates: DetectResult["candidates"] = [];
      const call = client.DetectEndpoints(request, metadata);

      call.on("data", (batch: any) => {
        const batchCandidates = (batch.candidates ?? []).map((ep: any) => ({
          name: ep.name,
          file_path: ep.file_path,
          confidence: ep.confidence,
          human_title: ep.human_title,
          human_description: ep.human_description,
          conversion_type: ep.conversion_type,
          client_dependency_json: ep.client_dependency_json,
          subcategory: ep.subcategory,
          signature: ep.signature,
          docstring: ep.docstring,
          line_number: ep.line_number,
        }));
        allCandidates.push(...batchCandidates);

        if (onBatch) {
          onBatch({
            candidates: allCandidates.length,
            classified: batch.functions_classified ?? 0,
            total: batch.total_functions ?? functions.length,
          });
        }
      });

      call.on("end", () => {
        client.close();
        resolve({ candidates: allCandidates, error: "" });
      });

      call.on("error", (err: any) => {
        client.close();
        resolve({
          candidates: allCandidates,
          error: `gRPC error: ${err.code}: ${err.details ?? err.message}`,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // DiscoverUseCases — uses Build RPC stream for bidirectional tool support
  // -----------------------------------------------------------------------

  async discoverUseCases(
    projectSchema: string,
    onProgress?: (info: { toolCalls: number; status: string; toolName?: string }) => void,
  ): Promise<DiscoverResult> {
    const grpc = await import("@grpc/grpc-js");
    const { loadProto } = await import("./proto-loader.js");
    const { SynapseService } = loadProto();

    const apiKey = resolveApiKey(this.workingDir);
    if (!apiKey) {
      return { useCases: [], error: "Missing API key." };
    }

    // Retry loop over transient gRPC errors — the stream can survive for
    // as long as the user is willing to wait, reconnecting on flaky network.
    const MAX_ATTEMPTS = 5;
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await this._discoverOnce(
        grpc,
        SynapseService,
        apiKey,
        projectSchema,
        onProgress,
      );

      // Terminal success — either got use cases or a non-retryable app error
      if (!result.__transient) {
        return { useCases: result.useCases, error: result.error };
      }

      lastError = result.error;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        onProgress?.({ toolCalls: 0, status: `retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})` });
        await sleep(backoff);
      }
    }

    return { useCases: [], error: `Discovery failed after ${MAX_ATTEMPTS} attempts: ${lastError}` };
  }

  private async _discoverOnce(
    grpc: typeof import("@grpc/grpc-js"),
    SynapseService: any,
    apiKey: string,
    projectSchema: string,
    onProgress?: (info: { toolCalls: number; status: string; toolName?: string }) => void,
  ): Promise<{ useCases: UseCase[]; error: string; __transient: boolean }> {
    const target = `${this.host}:${this.port}`;
    const credentials = shouldUseSecure(this.host, this.port)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const client = new SynapseService(target, credentials, CHANNEL_OPTIONS);

    const metadata = new grpc.Metadata();
    metadata.set("x-api-key", apiKey);

    let toolCallCount = 0;

    return new Promise<{ useCases: UseCase[]; error: string; __transient: boolean }>((resolve) => {
      const call = client.Build(metadata);

      // Send a build request with mode=discover
      call.write({
        build_request: {
          request_id: "",
          query: "__DISCOVER_USE_CASES__",
          project_schema: projectSchema,
          working_dir: this.workingDir,
          output_file: "",
          validate: false,
          docs: false,
          generate_only: false,
          todo_list_content: "",
          context_bundle: JSON.stringify({ mode: "discover", endpoints: [] }),
        },
      });

      call.on("data", async (msg: any) => {
        if (msg.status_update) {
          const update = msg.status_update;
          if (onProgress) {
            onProgress({
              toolCalls: toolCallCount,
              status: update.stage ?? "exploring",
            });
          }
        } else if (msg.tool_request) {
          // Handle tool callbacks (same as build)
          const req = msg.tool_request;
          toolCallCount++;
          if (onProgress) {
            onProgress({
              toolCalls: toolCallCount,
              status: "exploring",
              toolName: req.tool_name,
            });
          }

          let parameters: Record<string, unknown> = {};
          if (req.parameters) {
            try {
              const raw = Buffer.isBuffer(req.parameters)
                ? req.parameters.toString("utf-8")
                : typeof req.parameters === "string"
                  ? req.parameters
                  : new TextDecoder().decode(req.parameters);
              parameters = JSON.parse(raw);
            } catch { /* empty params */ }
          }

          const result = await this.toolExecutor.execute(req.tool_name, parameters);

          call.write({
            tool_response: {
              request_id: req.request_id,
              success: result.success,
              result: Buffer.from(JSON.stringify(result.result ?? {}), "utf-8"),
              error: result.error ?? "",
            },
          });
        } else if (msg.build_result) {
          // Discovery result comes as build_result with use cases in server_code (JSON)
          const res = msg.build_result;
          let useCases: UseCase[] = [];
          try {
            useCases = JSON.parse(res.server_code || "[]");
          } catch {
            useCases = [];
          }
          gotResult = true;
          call.end();
          client.close();
          resolve({ useCases, error: res.error ?? "", __transient: false });
        }
      });

      let gotResult = false;

      call.on("end", () => {
        client.close();
        if (!gotResult) {
          // Stream closed cleanly without a build_result — treat as transient
          resolve({
            useCases: [],
            error: "stream ended before result",
            __transient: true,
          });
        }
      });

      call.on("error", (err: any) => {
        client.close();
        const code = err.code as number | undefined;
        const transient = code !== undefined && RETRYABLE_GRPC_CODES.has(code);
        resolve({
          useCases: [],
          error: `gRPC error: ${err.code}: ${err.details ?? err.message}`,
          __transient: transient,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // Build — bidirectional streaming RPC
  // -----------------------------------------------------------------------

  async build(opts: {
    query: string;
    projectSchema: string;
    outputFile?: string;
    validate?: boolean;
    docs?: boolean;
    generateOnly?: boolean;
    todoListContent?: string;
    contextBundle?: Record<string, unknown>;
    callbacks?: BuildCallbacks;
    /** Session identifier — surfaces in Langfuse traces + on the CLI success box. */
    sessionId?: string;
  }): Promise<BuildResult & { sessionId: string }> {
    const grpc = await import("@grpc/grpc-js");
    const { loadProto } = await import("./proto-loader.js");
    const { SynapseService } = loadProto();

    // Per-build session id — shared with the backend so Langfuse traces line
    // up with what the user sees in the CLI. Backend echoes it into
    // status_updates and telemetry rows.
    const sessionId = opts.sessionId ?? _generateSessionId();

    const apiKey = resolveApiKey(this.workingDir);
    if (!apiKey) {
      return {
        success: false,
        error:
          "Missing API key. Set one with: synapse init, synapse config --key <KEY>, " +
          "or set SYNAPSE_API_KEY in the environment.",
        sessionId,
      };
    }

    // Retry loop — reconnect on transient gRPC failures BEFORE generation
    // begins.  Once the backend has started producing code (past the
    // `generating` stage), a mid-stream failure is surfaced verbatim so the
    // user can decide whether to restart — silently retrying would send the
    // same query twice and waste tokens.
    const MAX_ATTEMPTS = 5;
    let lastResult: BuildResult & { sessionId: string; __transient?: boolean } = {
      success: false,
      error: "no attempts made",
      sessionId,
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      lastResult = await this._buildOnce(grpc, SynapseService, apiKey, sessionId, opts);

      if (!lastResult.__transient) {
        return lastResult;
      }

      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        opts.callbacks?.onStatus?.(
          "retrying",
          `Connection dropped — reconnecting (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
          0.1,
        );
        await sleep(backoff);
      }
    }

    return {
      ...lastResult,
      error: `Build failed after ${MAX_ATTEMPTS} attempts: ${lastResult.error}`,
    };
  }

  private async _buildOnce(
    grpc: typeof import("@grpc/grpc-js"),
    SynapseService: any,
    apiKey: string,
    sessionId: string,
    opts: {
      query: string;
      projectSchema: string;
      outputFile?: string;
      validate?: boolean;
      docs?: boolean;
      generateOnly?: boolean;
      todoListContent?: string;
      contextBundle?: Record<string, unknown>;
      callbacks?: BuildCallbacks;
    },
  ): Promise<BuildResult & { sessionId: string; __transient?: boolean }> {
    const target = `${this.host}:${this.port}`;
    const credentials = shouldUseSecure(this.host, this.port)
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    const client = new SynapseService(target, credentials, CHANNEL_OPTIONS);

    const metadata = new grpc.Metadata();
    metadata.set("x-api-key", apiKey);

    return new Promise<BuildResult & { sessionId: string; __transient?: boolean }>((resolve) => {
      let finalResult: BuildResult & { sessionId: string } = {
        success: false,
        error: "No response received",
        sessionId,
      };
      // Track whether the backend has started actually generating code.
      // Retry-on-error is only safe BEFORE this point — mid-generation
      // failures propagate so the user can decide.
      let generationStarted = false;
      let gotFinalResult = false;

      // Open the bidirectional stream
      const call = client.Build(metadata);

      // Send the initial BuildMessage with build_request payload
      call.write({
        build_request: {
          request_id: sessionId,
          query: opts.query,
          project_schema: opts.projectSchema,
          working_dir: this.workingDir,
          output_file: opts.outputFile ?? "mcp_server.py",
          validate: opts.validate ?? true,
          docs: opts.docs ?? true,
          generate_only: opts.generateOnly ?? false,
          todo_list_content: opts.todoListContent ?? "",
          context_bundle: opts.contextBundle
            ? JSON.stringify(opts.contextBundle)
            : "",
        },
      });

      // Handle incoming server messages
      call.on("data", async (msg: any) => {
        // The proto-loader with `oneofs: true` exposes a `payload` field
        // whose value is the name of the active oneof branch.  However,
        // we also check the field names directly for robustness.

        if (msg.status_update) {
          const update = msg.status_update;
          const stage = (update.stage ?? "").toLowerCase();
          if (stage === "generating") {
            generationStarted = true;
          }
          opts.callbacks?.onStatus?.(
            update.stage,
            update.message,
            update.progress,
          );
        } else if (msg.tool_request) {
          const req = msg.tool_request;
          let parameters: Record<string, unknown> = {};
          if (req.parameters) {
            try {
              const raw = Buffer.isBuffer(req.parameters)
                ? req.parameters.toString("utf-8")
                : typeof req.parameters === "string"
                  ? req.parameters
                  : new TextDecoder().decode(req.parameters);
              parameters = JSON.parse(raw);
            } catch {
              // Leave parameters empty on parse failure
            }
          }

          // Execute the tool locally (async)
          const result = await this.toolExecutor.execute(
            req.tool_name,
            parameters,
          );
          opts.callbacks?.onToolCall?.(req.tool_name, result);

          // Send tool response back to the server
          call.write({
            tool_response: {
              request_id: req.request_id,
              success: result.success,
              result: Buffer.from(
                JSON.stringify(result.result ?? {}),
              ),
              error: result.error ?? "",
            },
          });
        } else if (msg.build_result) {
          const res = msg.build_result;
          finalResult = {
            success: res.success,
            serverCode: res.server_code,
            toolCount: res.tool_count,
            resourceCount: res.resource_count,
            documentation: res.documentation,
            todoList: res.todo_list,
            sessionId,
          };
          gotFinalResult = true;
          // Server has delivered the final result; close client side
          call.end();
        } else if (msg.error) {
          finalResult = {
            success: false,
            error: msg.error.message,
            errorCode: msg.error.code,
            sessionId,
          };
          gotFinalResult = true;
          call.end();
        }
      });

      call.on("end", () => {
        client.close();
        if (!gotFinalResult) {
          // Stream ended without a build_result — retry unless mid-generation
          resolve({
            ...finalResult,
            error: "stream ended before result",
            __transient: !generationStarted,
          });
          return;
        }
        resolve(finalResult);
      });

      call.on("error", (err: any) => {
        client.close();
        const code = err.code as number | undefined;
        const transient =
          !generationStarted && code !== undefined && RETRYABLE_GRPC_CODES.has(code);
        resolve({
          success: false,
          error: `gRPC error: ${err.code ?? "UNKNOWN"}: ${err.details ?? err.message}`,
          sessionId,
          __transient: transient,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // buildCustom (v2 Custom track) — bidi stream, but far simpler than v1:
  // CLI sends ONE CustomToolRequest, backend replies with ONE
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

    // Retry loop — mirrors _buildOnce / _discoverOnce. Cold-start
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
        const code = err.code as number | undefined;
        const transient = code !== undefined && RETRYABLE_GRPC_CODES.has(code);
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
  // Close (no-op convenience — each RPC creates its own client above)
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    // Individual RPCs create and close their own gRPC clients, so there
    // is nothing persistent to tear down here.  The method exists for
    // API compatibility with the Python SynapseClient.
  }
}
