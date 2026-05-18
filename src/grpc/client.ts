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

/** Standard channel options shared across all calls. */
const CHANNEL_OPTIONS = {
  "grpc.max_send_message_length": MAX_MESSAGE_SIZE,
  "grpc.max_receive_message_length": MAX_MESSAGE_SIZE,
  "grpc.keepalive_time_ms": 60_000,
  "grpc.keepalive_timeout_ms": 40_000,
  "grpc.keepalive_permit_without_calls": 0,
} as const;

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
      address = `${opts.host}:${opts.port ?? 443}`;
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
      const deadline = new Date(Date.now() + 60_000); // 60s timeout
      client.DetectEndpoints(
        request,
        metadata,
        { deadline },
        (err: any, response: any) => {
          client.close();
          if (err) {
            resolve({
              candidates: [],
              error: `gRPC error: ${err.code}: ${err.details}`,
            });
            return;
          }
          const candidates = (response.candidates ?? []).map((ep: any) => ({
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
          resolve({ candidates, error: response.error ?? "" });
        },
      );
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
  }): Promise<BuildResult> {
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
        success: false,
        error:
          "Missing API key. Set one with: synapse init, synapse config --key <KEY>, " +
          "or set SYNAPSE_API_KEY in the environment.",
      };
    }

    const metadata = new grpc.Metadata();
    metadata.set("x-api-key", apiKey);

    return new Promise<BuildResult>((resolve) => {
      let finalResult: BuildResult = {
        success: false,
        error: "No response received",
      };

      // Open the bidirectional stream
      const call = client.Build(metadata);

      // Send the initial BuildMessage with build_request payload
      call.write({
        build_request: {
          request_id: "",
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
          };
          // Server has delivered the final result; close client side
          call.end();
        } else if (msg.error) {
          finalResult = {
            success: false,
            error: msg.error.message,
            errorCode: msg.error.code,
          };
          call.end();
        }
      });

      call.on("end", () => {
        client.close();
        resolve(finalResult);
      });

      call.on("error", (err: any) => {
        client.close();
        resolve({
          success: false,
          error: `gRPC error: ${err.code ?? "UNKNOWN"}: ${err.details ?? err.message}`,
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
