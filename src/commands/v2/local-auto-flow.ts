// src/commands/v2/local-auto-flow.ts
//
// Local Auto track: extract HTTP surface deterministically, let the user
// pick which endpoints to expose, and mechanically render a passthrough
// MCP server file — no LLM call (endpoints are already fully specified)
// and nothing leaves the machine. This is the local counterpart to
// auto-flow.ts, which persists the same kind of config to the hosted
// backend instead of writing a file.

import path from "node:path";
import { input } from "@inquirer/prompts";
import type { HttpEndpoint, SurfaceManifest } from "../../extractors/core/surface-manifest.js";
import { pickEndpoints } from "./endpoint-picker.js";
import { writeWithSuffix, mergeEnvExample } from "./custom-flow.js";
import { t, stepInfo, sectionHeader } from "../../ui/theme.js";
import { roundedBox } from "../../ui/box.js";
import { Spinner } from "../../ui/spinner.js";

export interface LocalAutoFlowOptions {
  workingDir: string;
  manifest: SurfaceManifest;
  serverName?: string;
  baseUrl?: string;
  sessionId?: string;
  /** Anthropic key resolved by build-v2 for --local runs. Required for
   *  --smart-names to run — naming is skipped (mechanical fallback) if
   *  either the flag or the key is missing. */
  anthropicKey?: string | null;
  /** --smart-names: browse handler source (+ README/docs) to name/describe
   *  tools from real behavior instead of route + docstring alone. */
  smartNames?: boolean;
}

export async function runLocalAutoFlow(opts: LocalAutoFlowOptions): Promise<void> {
  const endpoints = opts.manifest.endpoints;

  if (endpoints.length === 0) {
    roundedBox("No Endpoints Found", "⚠", t.warn, [
      "The extractor didn't find any HTTP route decorators.",
      "",
      "Try:",
      "  " + t.cmd("synapse build --local --custom") + " — compose internal functions",
    ]);
    return;
  }

  stepInfo(
    "Detected",
    `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} (${opts.manifest.framework ?? "unknown framework"})`,
  );

  const selected = await pickEndpoints(endpoints);
  if (selected.length === 0) {
    stepInfo("No endpoints selected", "aborting");
    return;
  }

  const baseUrl =
    opts.baseUrl ??
    (
      await input({
        message: "Where is this API deployed? (leave blank to set later via env)",
        default: "",
      })
    ).trim();

  const serverName = opts.serverName ?? path.basename(opts.workingDir);

  sectionHeader("Generating", "⚡");

  // Smart naming runs for all languages — it reads handler source and calls
  // the model regardless of language. The generated *server file* is still
  // Python-only for now; non-Python repos get the naming pass + a note.
  const named = await maybeNameEndpoints(selected, opts);

  const lang = opts.manifest.language;
  if (lang !== "python") {
    // Show the named endpoint list so the user can see what was inferred,
    // then explain that local file generation requires --local without the
    // Python-only restriction lifted (hosted path handles all languages).
    stepInfo(
      "Smart naming complete",
      `${named.length} tool(s) named from ${lang} source`,
    );
    roundedBox("Server file generation: Python only for --local", "ℹ", t.warn, [
      `Smart naming ran on your ${lang} endpoints above.`,
      "",
      "Local server file generation currently writes Python only.",
      `Re-run without ${t.cmd("--local")} to push the named config to the`,
      "hosted backend, which serves all languages via the MCP runner.",
      "",
      "Named tools (will be available once hosted or once TypeScript/Go",
      "server generation is added):",
      ...named.map((ep) => `  ${ep.method.padEnd(6)} ${ep.path.padEnd(30)} ${ep.suggested_tool_name}`),
    ]);
    return;
  }

  const { renderPassthroughPython } = await import("../../backend/server-renderer.js");
  const { source, envVars } = renderPassthroughPython(named, serverName);

  const written = writeWithSuffix(opts.workingDir, "synapse_auto", "py", source);
  const baseUrlVar = "ENDPOINT_BASE_URL";
  mergeEnvExample(opts.workingDir, envVars);
  if (baseUrl) {
    // mergeEnvExample only fills in blank keys — patch the base URL value
    // in directly so users don't have to look it up again.
    const fs = await import("node:fs");
    const envPath = path.join(opts.workingDir, ".env.example");
    const contents = fs.readFileSync(envPath, "utf-8");
    fs.writeFileSync(
      envPath,
      contents.replace(new RegExp(`^${baseUrlVar}=$`, "m"), `${baseUrlVar}=${baseUrl}`),
      "utf-8",
    );
  }

  const relOutput = path.relative(opts.workingDir, written);
  const absOutput = path.resolve(opts.workingDir, written);
  const mcpEnv: Record<string, string> = {};
  for (const v of envVars) mcpEnv[v] = v === baseUrlVar && baseUrl ? baseUrl : "";

  const { renderSuccessMcp } = await import("../../ui/success.js");
  renderSuccessMcp({
    toolName: serverName,
    language: "python",
    outputPath: relOutput,
    sessionId: opts.sessionId,
    envVars,
    mcpConfig: {
      command: "python",
      args: [absOutput],
      ...(envVars.length > 0 ? { env: mcpEnv } : {}),
    },
    subtitle: "local auto-mode server — passthrough tools",
  });
}

/**
 * Reads each selected handler's real source (plus repo README/docs context)
 * and asks the model for a tool_name/description grounded in actual
 * behavior — covers the common case where the codebase has no docstrings,
 * so the mechanical `suggested_tool_name` (method + path) is the only
 * signal an agent would otherwise get. Falls back to the extractor's
 * mechanical values per endpoint (or entirely, on any failure) — never
 * blocks the build. Routed through the same client factory hosted --auto
 * uses, so the local and hosted `--smart-names` paths share one call site.
 */
async function maybeNameEndpoints(
  endpoints: HttpEndpoint[],
  opts: LocalAutoFlowOptions,
): Promise<HttpEndpoint[]> {
  if (!opts.smartNames || !opts.anthropicKey) return endpoints;

  const spinner = new Spinner("orbital");
  spinner.start("Naming tools from handler source");
  try {
    const { buildEndpointContexts } = await import("../../backend/endpoint-namer.js");
    const { readRepoContext } = await import("../../backend/repo-context.js");
    const { makeSynapseClient } = await import("../../grpc/client-factory.js");

    const client = makeSynapseClient({
      effectiveMode: "local",
      workingDir: opts.workingDir,
      anthropicKey: opts.anthropicKey,
    });
    const contexts = buildEndpointContexts(endpoints, opts.workingDir);
    const result = await client.nameEndpoints({
      endpoints: contexts,
      workingDir: opts.workingDir,
      readmeContext: readRepoContext(opts.workingDir),
      sessionId: opts.sessionId ?? "local-auto",
    });

    if (!result.success) {
      spinner.fail("Naming pass failed", result.error || "using route-derived names instead");
      return endpoints;
    }

    spinner.complete(`Named ${result.names.length}/${endpoints.length} tool(s) from source`);
    const byIndex = new Map(result.names.map((n) => [n.index, n]));
    return endpoints.map((ep, i) => {
      const named = byIndex.get(i);
      if (!named) return ep;
      return { ...ep, suggested_tool_name: named.tool_name, description: named.description };
    });
  } catch {
    spinner.fail("Naming pass failed", "using route-derived names instead");
    return endpoints;
  }
}
