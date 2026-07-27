// src/commands/v2/custom-flow.ts
//
// Custom track: user picks 2+ internal functions or describes a workflow,
// backend synthesizes a single MCP tool file, CLI writes it to the PROJECT
// ROOT (numeric-suffix on collision) and merges into ./.env.example.

import fs from "node:fs";
import path from "node:path";
import { input, checkbox, select } from "@inquirer/prompts";
import type { SurfaceManifest, SurfaceFunction } from "../../extractors/core/surface-manifest.js";
import { getBackendConfig } from "../../config/manager.js";
import { t, stepOk, stepInfo, stepWarn, sectionHeader } from "../../ui/theme.js";
import { roundedBox } from "../../ui/box.js";
import { Spinner } from "../../ui/spinner.js";
import { CodeGenerationUI } from "../../ui/code-gen-ui.js";
import { BULLET } from "../../ui/icons.js";
import {
  rankFunctionsInPlace,
  computeCallSiteCounts,
} from "../../extractors/languages/python-streamed.js";
import { serializeManifestForWire } from "../../extractors/core/manifest-wire.js";
import { renderErrorBox, ERROR_CODES, parseWireError } from "../../ui/errors.js";

import type { SessionManager } from "../../session/session-manager.js";

export interface CustomFlowOptions {
  workingDir: string;
  manifest: SurfaceManifest;
  intent?: string; // --query override
  /** Session id from the SessionManager — echoed into gRPC traces. */
  sessionId?: string;
  /** Abort signal from the SessionManager — plumbed into the classify call. */
  signal?: AbortSignal;
  /** --deep raises the classifier candidate cap. */
  deep?: boolean;
  /** SessionManager reference — used for recordError so failures land in
   *  the ledger for `synapse logs`. */
  session?: SessionManager;
}

/** Pick between "describe an intent" or "pick functions" — then collect the answer. */
async function collectIntent(functions: SurfaceFunction[]): Promise<{
  intent: string;
  selectedQualnames: string[];
  suggestedToolName: string;
}> {
  console.log();
  console.log(`  ${t.brandBold("Describe the workflow you want as an MCP tool")}`);
  console.log(`  ${t.dim("You can leave this blank and pick functions on the next screen.")}`);
  console.log();
  const intent = (
    await input({
      message: "Workflow",
      default: "",
    })
  ).trim();

  let selected: string[] = [];
  if (!intent) {
    const choices = functions.map((f) => ({
      name: `${f.module}::${f.qualname}  ${t.dim(`(${f.signature})`)}`,
      value: `${f.module}.${f.qualname}`,
      checked: false,
    }));

    const picked = await checkbox<string>({
      message: "Select the functions to compose (2+ recommended):",
      choices,
      pageSize: 15,
      loop: false,
    });
    selected = picked;
    if (selected.length === 0) {
      throw new Error("no functions selected and no workflow described");
    }
  }

  const suggestedToolName = (
    await input({
      message: "Optional tool name (leave blank to let Synapse choose):",
      default: "",
    })
  ).trim();

  return {
    intent: intent || `Compose these functions into a single MCP tool: ${selected.join(", ")}`,
    selectedQualnames: selected,
    suggestedToolName,
  };
}

/** Numeric-suffix writer — never overwrites existing files. */
function writeWithSuffix(dir: string, baseName: string, ext: string, contents: string): string {
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `${baseName}_server.${ext}`);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${baseName}_server_${n}.${ext}`);
    n += 1;
  }
  fs.writeFileSync(target, contents, "utf-8");
  return target;
}

/** Merge new env vars into <workingDir>/.env.example without duplicating keys. */
function mergeEnvExample(dir: string, envVars: string[]): void {
  if (envVars.length === 0) return;
  const envPath = path.join(dir, ".env.example");
  const existing: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (m) existing[m[1]] = line;
    }
  }
  for (const v of envVars) {
    if (!(v in existing)) existing[v] = `${v}=`;
  }
  const merged = Object.values(existing).join("\n") + "\n";
  fs.writeFileSync(envPath, merged, "utf-8");
}

// -----------------------------------------------------------------------------
// Discovery helpers (Stage 3b local ranking + Stage 4 backend classifier)
// -----------------------------------------------------------------------------

interface WorkflowProposal {
  name: string;
  purpose: string;
  functions: string[]; // "module.qualname"
  confidence: number;
}

async function tryDiscoverWorkflows(args: {
  manifest: SurfaceManifest;
  sessionId?: string;
  signal?: AbortSignal;
  deep: boolean;
  workingDir: string;
  session?: SessionManager;
}): Promise<WorkflowProposal[] | null> {
  if (args.manifest.functions.length < 2) return null;

  // 1) Local ranking: score every function, take top-K.
  const spinner = new Spinner("orbital");
  spinner.start("Ranking candidate functions");
  const topK = args.deep ? 500 : 200;
  const callCounts = await computeCallSiteCounts(
    args.workingDir,
    args.manifest.functions,
    args.signal,
  );
  const { ranked, background } = rankFunctionsInPlace(
    [...args.manifest.functions],
    callCounts,
    topK,
  );
  spinner.complete(
    `Ranked ${ranked.length} top candidates (from ${args.manifest.functions.length}${
      background.length > 0 ? `, ${background.length} below the bar` : ""
    })`,
  );

  // 2) Backend classifier: one gRPC round-trip, parallel Haiku shards.
  const rankedManifest: SurfaceManifest = {
    ...args.manifest,
    functions: ranked,
    background_functions: background,
  };

  const spinner2 = new Spinner("orbital");
  spinner2.start("Classifying candidates on the backend");

  const { SynapseClient } = await import("../../grpc/client.js");
  const backend = getBackendConfig();
  const client = new SynapseClient({
    url: backend.url ?? undefined,
    host: backend.host ?? undefined,
    port: backend.port ? parseInt(backend.port, 10) : undefined,
    workingDir: args.workingDir,
  });

  let classify: Awaited<ReturnType<typeof client.classifyCandidates>>;
  try {
    classify = await client.classifyCandidates({
      manifestJson: serializeManifestForWire(rankedManifest),
      sessionId: args.sessionId,
      signal: args.signal,
      onStatus: (_stage, message) => {
        if (message) spinner2.updateMessage(message);
      },
    });
  } catch (e) {
    spinner2.fail("Classification failed", String(e));
    args.session?.recordError({
      code: ERROR_CODES.NETWORK_TIMEOUT,
      stage: "classify",
      message: "Couldn't reach the classifier backend.",
      technical: String(e),
    });
    renderErrorBox({
      title: "Classifier Error",
      sessionId: args.sessionId,
      workingDir: args.workingDir,
      fallback: {
        code: ERROR_CODES.NETWORK_TIMEOUT,
        message: "Couldn't reach the classifier backend.",
        hint: "Continuing with the manual function picker. Check `synapse config` if this persists.",
      },
    });
    return null;
  }

  if (!classify.success && classify.verdicts.length === 0) {
    const wire = parseWireError(classify.error);
    spinner2.fail("Classification failed", wire?.user_message ?? classify.error ?? "unknown error");
    args.session?.recordError({
      code: wire?.error_code ?? ERROR_CODES.INTERNAL_ERROR,
      stage: "classify",
      message: wire?.user_message ?? classify.error ?? "no verdicts returned",
      hint: wire?.hint,
      technical: wire?.technical,
      missing_fields: wire?.missing_fields,
    });
    renderErrorBox({
      title: "Classifier Error",
      wire,
      sessionId: args.sessionId,
      workingDir: args.workingDir,
      fallback: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: classify.error || "no verdicts returned",
        hint: "Continuing with the manual function picker.",
      },
    });
    return null;
  }

  spinner2.complete(
    `Classified ${classify.verdicts.length} function(s) (${classify.shards_run} shard(s), ${classify.cached_hits} cache hit(s))`,
  );

  // 3) Ask the backend for workflow proposals, streamed over the same
  //    tool_shaper path with verdicts attached. We reuse buildCustom for
  //    now — future D-follow-up can expose a dedicated proposals RPC.
  //    Skip the LLM proposal call if the classifier already gave us fewer
  //    than 2 promotable functions — nothing to cluster.
  const promotable = classify.verdicts.filter(
    (v) => v.band === "HIGH" || v.band === "MEDIUM",
  );
  if (promotable.length < 2) {
    stepInfo("No workflow clusters", "falling back to manual function picker");
    return null;
  }

  // Encode "workflows-only" intent so buildCustom returns proposals shaped
  // like a ToolPlan we can present. The `intent` field is what steers the
  // Sonnet-side clustering when verdicts are present in the payload.
  // NOTE: an eventual follow-up will add a dedicated propose_workflows RPC.
  // For M1 we skip that hop and just surface the ranked HIGH/MED verdicts
  // for the user to compose from.
  const grouped = groupByHint(promotable, args.manifest);
  const proposals: WorkflowProposal[] = grouped.slice(0, 5).map((g) => ({
    name: g.name,
    purpose: g.purpose,
    functions: g.functions,
    confidence: g.confidence,
  }));
  return proposals;
}

function groupByHint(
  verdicts: Array<Record<string, unknown>>,
  manifest: SurfaceManifest,
): Array<{
  name: string;
  purpose: string;
  functions: string[];
  confidence: number;
}> {
  // Tier 1: cluster by workflow_hints[0] when the classifier tagged them.
  const byHint = new Map<string, string[]>();
  for (const v of verdicts) {
    const q = (v.qualname as string) ?? "";
    const hints = ((v.workflow_hints as string[]) ?? []).filter(Boolean);
    if (!q || hints.length === 0) continue;
    const bucket = hints[0];
    if (!byHint.has(bucket)) byHint.set(bucket, []);
    byHint.get(bucket)!.push(q);
  }
  const groups: Array<{ name: string; purpose: string; functions: string[]; confidence: number }> = [];
  for (const [hint, quals] of byHint) {
    if (quals.length < 2) continue;
    groups.push({
      name: `${hint}_workflow`,
      purpose: `Compose ${quals.length} ${hint}-related functions into one MCP tool`,
      functions: quals,
      confidence: Math.min(1, 0.5 + quals.length * 0.1),
    });
  }

  // Tier 2: no hint clusters — group by declaring module (which usually IS
  // a domain in real code, e.g. all functions in linkedin_post.py go together).
  if (groups.length === 0) {
    const byModule = new Map<string, string[]>();
    const promotableQuals = new Set(
      verdicts.map((v) => (v.qualname as string) ?? "").filter(Boolean),
    );
    for (const f of manifest.functions) {
      if (!promotableQuals.has(f.qualname)) continue;
      const bucket = f.module || "root";
      if (!byModule.has(bucket)) byModule.set(bucket, []);
      byModule.get(bucket)!.push(`${f.module}.${f.qualname}`);
    }
    for (const [mod, quals] of byModule) {
      if (quals.length < 2) continue;
      groups.push({
        name: `${mod.replace(/\W+/g, "_")}_workflow`,
        purpose: `Compose ${quals.length} functions from ${mod} into one MCP tool`,
        functions: quals,
        confidence: 0.6,
      });
    }
  }

  // Tier 3: nothing clustered — propose one combined workflow from every
  // promotable function, so the user always has something to click through.
  if (groups.length === 0 && verdicts.length >= 2) {
    groups.push({
      name: "combined_workflow",
      purpose: `Compose ${verdicts.length} top-ranked functions into one MCP tool`,
      functions: verdicts.map((v) => (v.qualname as string) ?? "").filter(Boolean),
      confidence: 0.5,
    });
  }

  groups.sort((a, b) => b.confidence - a.confidence);
  return groups;
}

async function pickProposal(
  proposals: WorkflowProposal[],
): Promise<WorkflowProposal | null> {
  const CUSTOM_VALUE = "__CUSTOM__";
  const choices: Array<{ name: string; value: string; description?: string }> = proposals.map(
    (p, i) => ({
      name: `${t.brand(p.name)}  ${t.dim(`(${p.functions.length} fn, conf ${p.confidence.toFixed(2)})`)}`,
      value: String(i),
      description: p.purpose,
    }),
  );
  choices.push({ name: t.dim("Custom — describe your own workflow instead"), value: CUSTOM_VALUE });

  const picked = await select<string>({
    message: "Pick a workflow proposal to compose:",
    choices,
    pageSize: 10,
    loop: false,
  });
  if (picked === CUSTOM_VALUE) return null;
  const idx = Number(picked);
  if (Number.isNaN(idx) || !proposals[idx]) return null;
  return proposals[idx];
}

function stripModulePrefix(fullyQualified: string): string {
  const dot = fullyQualified.lastIndexOf(".");
  return dot === -1 ? fullyQualified : fullyQualified.slice(dot + 1);
}

export async function runCustomFlow(opts: CustomFlowOptions): Promise<void> {
  const functions = opts.manifest.functions;

  if (functions.length === 0 && !opts.intent) {
    roundedBox("No Composable Functions", "⚠", t.warn, [
      "The extractor didn't find any public non-endpoint functions in this project.",
      "",
      "Try:",
      "  " + t.cmd("synapse build --auto") + " — expose your HTTP endpoints",
    ]);
    return;
  }

  let intent = opts.intent ?? "";
  let selectedQualnames: string[] = [];
  let suggestedToolName = "";

  // ---------------------------------------------------------------------------
  // Discovery: rank locally (zero tokens), classify in parallel on the backend
  // (Haiku shards, one round-trip), let the user pick a proposal or fall back
  // to raw pickers. Only runs when the user hasn't provided an explicit intent.
  // ---------------------------------------------------------------------------
  if (!intent && functions.length > 0) {
    const proposals = await tryDiscoverWorkflows({
      manifest: opts.manifest,
      sessionId: opts.sessionId,
      signal: opts.signal,
      deep: opts.deep ?? false,
      workingDir: opts.workingDir,
      session: opts.session,
    });

    if (proposals && proposals.length > 0) {
      const chosen = await pickProposal(proposals);
      if (chosen) {
        intent = `Compose these functions into a single MCP tool: ${chosen.functions.join(", ")}. Purpose: ${chosen.purpose}`;
        selectedQualnames = chosen.functions.map(stripModulePrefix);
        suggestedToolName = chosen.name;
      }
    }
  }

  if (!intent) {
    const answers = await collectIntent(functions);
    intent = answers.intent;
    selectedQualnames = answers.selectedQualnames;
    suggestedToolName = answers.suggestedToolName;
  }

  sectionHeader("Generating", "⚡");

  // Two-phase UX (mirrors v1): a Spinner for pre-generation stages (shape,
  // render), and CodeGenerationUI tip box once the backend flips to
  // "generating". Falls back cleanly on non-TTY / --no-tty.
  const state = {
    spinner: null as Spinner | null,
    genUI: null as CodeGenerationUI | null,
  };
  const genStartTime = Date.now();
  let currentStage = "";

  const onStatus = (stage: string, message: string, _progress: number): void => {
    const s = (stage || "").toLowerCase();
    if (!s || s === currentStage) return;
    currentStage = s;

    // Transition to tip box once real generation begins.
    if ((s === "generating" || s === "shaping") && !state.genUI) {
      if (state.spinner) { state.spinner.stop(); state.spinner = null; }
      state.genUI = new CodeGenerationUI();
      state.genUI.start(genStartTime);
      return;
    }

    // Pre-generation / post-generation stages ride the orbital spinner.
    if (!state.genUI) {
      if (!state.spinner) {
        state.spinner = new Spinner("orbital");
        state.spinner.resetTimer();
        state.spinner.start(message || s);
      } else {
        state.spinner.updateMessage(message || s);
      }
    }
  };

  // Kick off the compose with an initial spinner; the first status_update
  // from the backend will swap it for the tip box.
  state.spinner = new Spinner("orbital");
  state.spinner.start("Composing MCP tool");

  const { SynapseClient } = await import("../../grpc/client.js");
  const backend = getBackendConfig();
  const client = new SynapseClient({
    url: backend.url ?? undefined,
    host: backend.host ?? undefined,
    port: backend.port ? parseInt(backend.port, 10) : undefined,
    workingDir: opts.workingDir,
  });

  let result;
  try {
    result = await client.buildCustom({
      language: opts.manifest.language,
      manifestJson: serializeManifestForWire(opts.manifest),
      intent,
      selectedQualnames,
      suggestedToolName,
      sessionId: opts.sessionId,
      onStatus,
    });
  } finally {
    if (state.genUI) { state.genUI.complete(); state.genUI = null; }
    if (state.spinner) { state.spinner.stop(); state.spinner = null; }
  }

  if (result.error && !result.file_source) {
    const wire = parseWireError(result.error);
    opts.session?.recordError({
      code: wire?.error_code ?? ERROR_CODES.LLM_OUTPUT_INVALID,
      stage: "shape",
      message: wire?.user_message ?? result.error,
      hint: wire?.hint,
      technical: wire?.technical,
      missing_fields: wire?.missing_fields,
    });
    renderErrorBox({
      title: "Composition Failed",
      wire,
      sessionId: opts.sessionId,
      workingDir: opts.workingDir,
      fallback: {
        code: ERROR_CODES.LLM_OUTPUT_INVALID,
        message: result.error || "the backend didn't return a rendered file",
      },
    });
    return;
  }

  const written = writeWithSuffix(
    opts.workingDir,
    result.tool_name || "custom_tool",
    result.file_extension || "py",
    result.file_source,
  );
  mergeEnvExample(opts.workingDir, result.env_vars);

  if (!result.success) {
    stepWarn("Verify checks did not pass", "file written anyway — review before running");
  }

  // Detect env vars from the rendered code, same regex the v1 flow used —
  // catches os.getenv("FOO") calls even if the backend didn't report them.
  const envVarMatches = (result.file_source ?? "").matchAll(
    /os\.getenv\(["']([A-Z_][A-Z0-9_]*)["']/g,
  );
  const envVars = Array.from(new Set([
    ...result.env_vars,
    ...[...envVarMatches].map((m) => m[1]),
  ]));

  const relOutput = path.relative(opts.workingDir, written);
  const boxLines: string[] = [];
  boxLines.push(`${t.dim("Tool:")}      ${t.num(result.tool_name || "custom_tool")}`);
  boxLines.push(`${t.dim("Language:")}  ${opts.manifest.language}`);
  boxLines.push(`${t.dim("Output:")}    ${t.path(relOutput)}`);
  // Session id — quote this when reporting an issue; matches Langfuse trace.
  if (opts.sessionId) {
    boxLines.push(`${t.dim("Session:")}   ${t.subtle(opts.sessionId)}`);
  }

  if (envVars.length > 0) {
    boxLines.push("");
    boxLines.push(`${t.dim("Required environment variables:")}`);
    for (const v of envVars) {
      boxLines.push(`  ${t.warn(BULLET)} ${t.cmd(v)}`);
    }
  }

  boxLines.push("");
  boxLines.push(`${t.dim("Next steps:")}`);
  boxLines.push(`  ${t.num("1.")} Review ${t.path(relOutput)}`);
  boxLines.push(`  ${t.num("2.")} ${t.cmd("pip install mcp")}`);
  boxLines.push(`  ${t.num("3.")} ${t.cmd(`python ${relOutput}`)}`);

  console.log();
  roundedBox("MCP Server Generated", "✓", t.ok, boxLines);

  // MCP client config — printed outside the box, copy-paste friendly.
  const absOutput = path.resolve(opts.workingDir, written);
  const configName = `synapse-${result.tool_name || "custom-tool"}`.replace(/_/g, "-");
  const mcpServerConfig: Record<string, unknown> = {
    command: "python",
    args: [absOutput],
  };
  if (envVars.length > 0) {
    const envObj: Record<string, string> = {};
    for (const v of envVars) envObj[v] = "";
    mcpServerConfig.env = envObj;
  }
  const configSnippet = JSON.stringify(
    { mcpServers: { [configName]: mcpServerConfig } },
    null,
    2,
  );
  console.log();
  console.log(`  ${t.dim("Add this to your MCP client config:")}`);
  console.log();
  for (const line of configSnippet.split("\n")) {
    console.log(`    ${t.subtle(line)}`);
  }
  console.log();

  if (envVars.length > 0) {
    stepWarn(
      `Set ${envVars.length} environment variable${envVars.length === 1 ? "" : "s"} before running:`,
      envVars.join(", "),
    );
    console.log();
  }
  if (opts.sessionId) {
    stepInfo("Session", `${opts.sessionId}  ${t.dim("— quote this when reporting an issue")}`);
  }
  stepOk("Done");
}
