// src/backend/index.ts
//
// LocalSynapseClient — in-process TS codegen backend for `--local` mode.
// Composes classify → shape → render → smoke-verify. Public surface matches
// the gRPC SynapseClient so callers swap via the client factory (L10).
//
// The LLM provider is injected, not constructed here: the CLI resolves which
// provider and models to use (config/llm-config.ts) and builds it
// (providers/index.ts), so this class is identical whether it is running on
// Anthropic, OpenAI, Groq, xAI, OpenRouter, Ollama or a self-hosted endpoint.

import type { LlmProvider } from "../providers/types.js";
import { classifyCandidates as classifyImpl } from "./candidate-classifier.js";
import { shapeTool } from "./tool-shaper.js";
import { renderPython } from "./server-renderer.js";
import { verifyAndRepair } from "./smoke-verifier.js";
import { installationId } from "./trace-forwarder.js";
import { nameAndDescribeEndpoints, type EndpointContext } from "./endpoint-namer.js";
import type { SurfaceManifest } from "../extractors/core/surface-manifest.js";
import type { FunctionVerdict } from "./schemas.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Read the CLI version from package.json for trace records.
let _cliVersion: string | null = null;
function readCliVersion(): string {
  if (_cliVersion) return _cliVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // At runtime this file lives at dist/backend/index.js or dist/index.js;
    // package.json is one or two directories up.
    for (const candidate of [
      join(here, "..", "package.json"),
      join(here, "..", "..", "package.json"),
      join(here, "..", "..", "..", "package.json"),
    ]) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) {
          _cliVersion = pkg.version;
          return _cliVersion;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  _cliVersion = "0.0.0";
  return _cliVersion;
}

function generateSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `sess_${ts}${rand}`;
}

// -----------------------------------------------------------------------------
// Return-shape types match the gRPC client so the factory in L10 can hand
// either impl to the same commands without changing their shape.
// -----------------------------------------------------------------------------

export interface BuildCallbacks {
  onStatus?: (stage: string, message: string, progress: number) => void;
  onToolCall?: (toolName: string, result: unknown) => void;
}

export interface CustomBuildResult {
  success: boolean;
  tool_name: string;
  file_extension: string;
  file_source: string;
  env_vars: string[];
  report_json: string;
  error: string;
  sessionId: string;
}

export interface ClassifyResult {
  success: boolean;
  verdicts: Array<Record<string, unknown>>;
  shards_run: number;
  cached_hits: number;
  budget_dropped: number;
  error: string;
  sessionId: string;
}

export interface NameEndpointsResult {
  success: boolean;
  names: Array<{ index: number; tool_name: string; description: string }>;
  error: string;
  sessionId: string;
}

// -----------------------------------------------------------------------------
// LocalSynapseClient
// -----------------------------------------------------------------------------

export class LocalSynapseClient {
  private provider: LlmProvider;
  private cliVersion: string;
  private installationId: string;

  constructor(opts: { provider: LlmProvider; workingDir?: string }) {
    if (!opts.provider) {
      throw new Error(
        "LocalSynapseClient requires an LLM provider. " +
          "Run `synapse model` to check your configuration.",
      );
    }
    this.provider = opts.provider;
    void opts.workingDir;
    this.cliVersion = readCliVersion();
    this.installationId = installationId();
  }

  // ---------------------------------------------------------------------
  // buildCustom — the v2 Custom track. Manifest in, MCP tool file out.
  // Composes classify (optional) → shape → render → smoke-verify.
  // ---------------------------------------------------------------------

  async buildCustom(opts: {
    language: string;
    manifestJson: string;
    intent: string;
    selectedQualnames?: string[];
    suggestedToolName?: string;
    sessionId?: string;
    onStatus?: (stage: string, message: string, progress: number) => void;
  }): Promise<CustomBuildResult> {
    const sessionId = opts.sessionId ?? generateSessionId();

    if (opts.language !== "python") {
      return {
        success: false,
        tool_name: "",
        file_extension: "",
        file_source: "",
        env_vars: [],
        report_json: "",
        error:
          `Local mode currently generates Python MCP servers only ` +
          `(got language=${opts.language}). Use --local with a Python project, ` +
          `or re-init without --local for the hosted service which supports more languages.`,
        sessionId,
      };
    }

    let manifest: SurfaceManifest;
    try {
      manifest = JSON.parse(opts.manifestJson) as SurfaceManifest;
    } catch (e) {
      return {
        success: false,
        tool_name: "",
        file_extension: "",
        file_source: "",
        env_vars: [],
        report_json: "",
        error: `manifest_json parse failed: ${(e as Error).message}`,
        sessionId,
      };
    }

    try {
      // Stage 1: shape (no separate classify pre-pass here — shape-tool
      // handles both the "selected qualnames" and "narrow with verdicts"
      // paths on its own).
      const plan = await shapeTool({
        provider: this.provider,
        manifest,
        intent: opts.intent,
        selectedQualnames: opts.selectedQualnames ?? [],
        suggestedToolName: opts.suggestedToolName ?? "",
        sessionId,
        onStatus: opts.onStatus,
        cliVersion: this.cliVersion,
        installationId: this.installationId,
      });

      // Stage 2: render (deterministic, no LLM)
      opts.onStatus?.("rendering", "Rendering MCP server file", 0.75);
      const rendered = renderPython(
        plan,
        manifest,
        opts.suggestedToolName || plan.tool_name || "synapse-local",
      );

      // Stage 3: smoke-verify (+ one repair pass on failure)
      const { source, report } = await verifyAndRepair({
        provider: this.provider,
        source: rendered,
        manifest,
        sessionId,
        onStatus: opts.onStatus,
        cliVersion: this.cliVersion,
        installationId: this.installationId,
      });

      opts.onStatus?.("done", "MCP server ready", 1.0);

      return {
        success: report.verify_ok,
        tool_name: plan.tool_name,
        file_extension: "py",
        file_source: source,
        env_vars: plan.env_vars,
        report_json: JSON.stringify(report),
        error: report.verify_ok
          ? ""
          : `verification failed on ${report.check}: ${report.errors.join("; ")}`,
        sessionId,
      };
    } catch (e) {
      return {
        success: false,
        tool_name: "",
        file_extension: "",
        file_source: "",
        env_vars: [],
        report_json: "",
        error: `local-backend error: ${(e as Error).message}`,
        sessionId,
      };
    }
  }

  // ---------------------------------------------------------------------
  // classifyCandidates — Haiku fan-out over the manifest. Local-mode
  // equivalent of the hosted classify_request RPC. Same return shape.
  // ---------------------------------------------------------------------

  async classifyCandidates(opts: {
    manifestJson: string;
    shardSize?: number;
    maxShards?: number;
    sessionId?: string;
    signal?: AbortSignal;
    onStatus?: (stage: string, message: string, progress: number) => void;
    timeoutMs?: number;
  }): Promise<ClassifyResult> {
    const sessionId = opts.sessionId ?? generateSessionId();
    void opts.signal;
    void opts.timeoutMs;

    let manifest: SurfaceManifest;
    try {
      manifest = JSON.parse(opts.manifestJson) as SurfaceManifest;
    } catch (e) {
      return {
        success: false,
        verdicts: [],
        shards_run: 0,
        cached_hits: 0,
        budget_dropped: 0,
        error: `manifest_json parse failed: ${(e as Error).message}`,
        sessionId,
      };
    }

    try {
      const result = await classifyImpl({
        provider: this.provider,
        manifest,
        sessionId,
        shardSize: opts.shardSize,
        maxShards: opts.maxShards,
        onStatus: opts.onStatus,
        cliVersion: this.cliVersion,
        installationId: this.installationId,
      });

      return {
        success: true,
        verdicts: result.verdicts.map((v: FunctionVerdict) => ({
          qualname: v.qualname,
          band: v.band,
          tool_shape: v.tool_shape,
          workflow_hints: v.workflow_hints,
          one_line_purpose: v.one_line_purpose,
        })),
        shards_run: result.shards_run,
        cached_hits: 0, // local has no cache
        budget_dropped: result.budget_dropped,
        error: result.error,
        sessionId,
      };
    } catch (e) {
      return {
        success: false,
        verdicts: [],
        shards_run: 0,
        cached_hits: 0,
        budget_dropped: 0,
        error: `local classifier error: ${(e as Error).message}`,
        sessionId,
      };
    }
  }

  // ---------------------------------------------------------------------
  // nameEndpoints (v2 Auto-mode --smart-names) — reads each handler's real
  // source (embedded in the caller-built EndpointContext) plus repo readme
  // context and asks Haiku for an agent-legible tool_name + description.
  // ---------------------------------------------------------------------

  async nameEndpoints(opts: {
    endpoints: EndpointContext[];
    workingDir: string;
    readmeContext?: string;
    sessionId?: string;
    signal?: AbortSignal;
    onStatus?: (stage: string, message: string, progress: number) => void;
    timeoutMs?: number;
  }): Promise<NameEndpointsResult> {
    const sessionId = opts.sessionId ?? generateSessionId();
    void opts.signal;
    void opts.timeoutMs;
    void opts.workingDir;

    try {
      const map = await nameAndDescribeEndpoints({
        provider: this.provider,
        endpoints: opts.endpoints,
        sessionId,
        readmeContext: opts.readmeContext,
        cliVersion: this.cliVersion,
        installationId: this.installationId,
        onStatus: opts.onStatus,
      });
      const names = Array.from(map.entries()).map(([index, v]) => ({
        index,
        tool_name: v.tool_name,
        description: v.description,
      }));
      return { success: true, names, error: "", sessionId };
    } catch (e) {
      return {
        success: false,
        names: [],
        error: `local namer error: ${(e as Error).message}`,
        sessionId,
      };
    }
  }

  // ---------------------------------------------------------------------
  // discoverUseCases — hosted-only in v1 (uses agentic_generator.py's
  // ReAct loop, not ported). Custom-flow works fully in local mode.
  // ---------------------------------------------------------------------

  async discoverUseCases(): Promise<{
    useCases: never[];
    error: string;
  }> {
    return {
      useCases: [],
      error:
        "Use-case discovery (v1 track) is not available in --local mode. " +
        "Use custom flow instead — it works fully offline.",
    };
  }

  // ---------------------------------------------------------------------
  // build (v1 template/agentic track) — hosted-only. Local mode is
  // v2 Custom-only for now.
  // ---------------------------------------------------------------------

  async build(): Promise<{
    success: boolean;
    error: string;
    sessionId: string;
  }> {
    const sessionId = generateSessionId();
    return {
      success: false,
      error:
        "The v1 build track is not available in --local mode. " +
        "Local mode ships the v2 Custom track only. Re-run without --local " +
        "if you need v1 (via the hosted service).",
      sessionId,
    };
  }

  // ---------------------------------------------------------------------
  // detect — hosted-only. Local mode doesn't ship endpoint detection.
  // ---------------------------------------------------------------------

  async detect(): Promise<{ candidates: never[]; error: string }> {
    return {
      candidates: [],
      error: "detect() is hosted-only. Local mode does not ship endpoint detection.",
    };
  }

  async close(): Promise<void> {
    // No persistent connections to tear down.
  }
}
