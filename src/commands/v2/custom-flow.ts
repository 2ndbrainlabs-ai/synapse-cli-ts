// src/commands/v2/custom-flow.ts
//
// Custom track: user picks 2+ internal functions or describes a workflow,
// backend synthesizes a single MCP tool file, CLI writes it into ./mcp/
// (numeric-suffix on collision) and updates ./mcp/.env.example.

import fs from "node:fs";
import path from "node:path";
import { input, checkbox, select } from "@inquirer/prompts";
import type { SurfaceManifest, SurfaceFunction } from "../../extractors/core/surface-manifest.js";
import { getBackendConfig } from "../../config/manager.js";
import { t, stepOk, stepInfo, stepWarn } from "../../ui/theme.js";
import { roundedBox } from "../../ui/box.js";
import { Spinner } from "../../ui/spinner.js";
import {
  rankFunctionsInPlace,
  computeCallSiteCounts,
} from "../../extractors/languages/python-streamed.js";
import { serializeManifestForWire } from "../../extractors/core/manifest-wire.js";

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

/** Merge new env vars into ./mcp/.env.example without duplicating keys. */
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
    return null;
  }

  if (!classify.success && classify.verdicts.length === 0) {
    spinner2.fail("Classification failed", classify.error || "no verdicts returned");
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
  const grouped = groupByHint(promotable);
  const proposals: WorkflowProposal[] = grouped.slice(0, 5).map((g) => ({
    name: g.name,
    purpose: g.purpose,
    functions: g.functions,
    confidence: g.confidence,
  }));
  return proposals;
}

function groupByHint(verdicts: Array<Record<string, unknown>>): Array<{
  name: string;
  purpose: string;
  functions: string[];
  confidence: number;
}> {
  const byHint = new Map<string, string[]>();
  for (const v of verdicts) {
    const q = (v.qualname as string) ?? "";
    const hints = ((v.workflow_hints as string[]) ?? []).filter(Boolean);
    const bucket = hints[0] ?? "general";
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
      confidence: Math.min(1, quals.length * 0.2),
    });
  }
  // Fallback: if hints didn't cluster, propose one "combined" workflow.
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

  const spinner = new Spinner("orbital");
  spinner.start("Composing MCP tool");

  const { SynapseClient } = await import("../../grpc/client.js");
  const backend = getBackendConfig();
  const client = new SynapseClient({
    url: backend.url ?? undefined,
    host: backend.host ?? undefined,
    port: backend.port ? parseInt(backend.port, 10) : undefined,
    workingDir: opts.workingDir,
  });

  const result = await client.buildCustom({
    language: opts.manifest.language,
    manifestJson: serializeManifestForWire(opts.manifest),
    intent,
    selectedQualnames,
    suggestedToolName,
    onStatus: (stage, message, _progress) => {
      if (stage) spinner.updateMessage(message || stage);
    },
  });

  if (result.error && !result.file_source) {
    spinner.fail("Composition failed", result.error);
    return;
  }

  const mcpDir = path.join(opts.workingDir, "mcp");
  const written = writeWithSuffix(
    mcpDir,
    result.tool_name || "custom_tool",
    result.file_extension || "py",
    result.file_source,
  );
  mergeEnvExample(mcpDir, result.env_vars);

  if (result.success) {
    spinner.complete(`Composed ${result.tool_name}`);
  } else {
    spinner.fail("Verify checks did not pass", result.error);
    stepWarn("File written anyway", "review it before running");
  }

  stepOk("Written", written);
  if (result.env_vars.length > 0) {
    stepInfo(".env.example", `merged ${result.env_vars.length} env var(s)`);
  }
  console.log();
  console.log(`  ${t.dim("Next steps:")}`);
  console.log(`    ${t.num("1.")} Review ${t.path(path.relative(opts.workingDir, written))}`);
  console.log(`    ${t.num("2.")} ${t.cmd("pip install mcp")}`);
  console.log(`    ${t.num("3.")} ${t.cmd(`python ${path.relative(opts.workingDir, written)}`)}`);
  console.log();
}
