/**
 * `synapse build` command -- full implementation.
 *
 * Ported from Python commands/build_command.py.
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { isInitialized, resolveApiKey, getBackendConfig } from "../config/manager.js";
import {
  getProjectSynapseDir,
  getProjectSchemaPath,
  getEndpointsCachePath,
  getContextMdPath,
} from "../config/paths.js";
import { t, sectionBox, stepOk, stepWarn, stepInfo, stepBrand, sectionHeader } from "../ui/theme.js";
import type { EndpointCandidate } from "../ui/endpoint-selector.js";
import type { ValidationResult, AvailableComponents } from "../builder/context-search.js";

export interface BuildOptions {
  query?: string;
  output: string;
  validate: boolean;
  docs: boolean;
  generateOnly: boolean;
}

// ---------------------------------------------------------------------------
// _DetectedEndpointProxy
// ---------------------------------------------------------------------------

class _DetectedEndpointProxy {
  name: string;
  filePath: string;
  signature: string;
  docstring: string;
  returnType: string;
  confidence: number;
  conversionType: string;
  subcategory: string;
  humanTitle: string;
  humanDescription: string;
  lineNumber: number;
  clientDependency: Record<string, unknown> | null;

  constructor(raw: Record<string, unknown>, workingDir: string) {
    this.name = (raw.name as string) ?? "";
    const rel = (raw.file_path as string) ?? "";
    this.filePath = rel && !path.isAbsolute(rel) ? path.join(workingDir, rel) : rel;
    this.signature = (raw.signature as string) ?? `def ${this.name}(...)`;
    this.docstring = (raw.docstring as string) ?? "";
    this.returnType = (raw.return_type as string) || "Any";
    this.confidence = Number(raw.confidence ?? 0.5);
    this.conversionType = (raw.conversion_type as string) ?? "ready";
    this.subcategory = (raw.subcategory as string) ?? "";
    this.humanTitle = (raw.human_title as string) ?? this.name;
    this.humanDescription = (raw.human_description as string) ?? "";
    this.lineNumber = Number(raw.line_number ?? 0);
    const cdJson = (raw.client_dependency_json as string) ?? "";
    try { this.clientDependency = cdJson ? JSON.parse(cdJson) : null; }
    catch { this.clientDependency = null; }
  }

  toEndpointCandidate(workingDir: string): EndpointCandidate {
    return {
      name: this.name,
      filePath: path.relative(workingDir, this.filePath),
      confidence: this.confidence,
      humanTitle: this.humanTitle,
      humanDescription: this.humanDescription,
      conversionType: this.conversionType,
      clientDependencyJson: this.clientDependency ? JSON.stringify(this.clientDependency) : "",
      subcategory: this.subcategory,
      signature: this.signature,
      docstring: this.docstring,
      lineNumber: this.lineNumber,
    };
  }
}

function formatEndpointForPlanner(ep: _DetectedEndpointProxy, workingDir: string): string {
  const rel = path.relative(workingDir, ep.filePath);
  const lines = [
    `### Function: \`${ep.name}\``,
    `- File: \`${rel}\``,
    `- Signature: \`${ep.signature}\``,
    `- Conversion Type: ${ep.conversionType.toUpperCase()}`,
  ];
  if (ep.conversionType === "requires_wrapper" && ep.clientDependency) {
    const cd = ep.clientDependency;
    lines.push(`- Client Required: ${cd.client_name ?? ""}`);
    lines.push(`- Library: ${cd.library ?? ""}`);
    const envVars = cd.env_vars as string[] | undefined;
    if (envVars?.length) lines.push(`- Environment Variables: ${envVars.join(", ")}`);
  }
  const first = ep.docstring?.split("\n")[0]?.trim();
  if (first) lines.push(`- Description: ${first}`);
  if (ep.returnType && ep.returnType !== "Any") lines.push(`- Return Type: \`${ep.returnType}\``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Interactive helpers
// ---------------------------------------------------------------------------

function promptLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function displayContextValidationUI(
  validation: ValidationResult,
  workingDir: string,
): Promise<[boolean, string | null]> {
  const { status, results, message, query } = validation;

  if (status === "valid") return [true, null];

  if (status === "insufficient") {
    sectionBox("No Relevant Code Found", "err", [
      "",
      `${t.dim("Query:")} ${t.text(query)}`,
      "",
      t.dim(message),
      "",
      t.dim("Synapse can only create MCP servers from code that"),
      t.dim("EXISTS in your codebase."),
      "",
    ]);

    let choice: string;
    try {
      const { select } = await import("@inquirer/prompts");
      const answer = await select<string>({
        message: t.brand("What would you like to do?"),
        choices: [
          { name: `${chalk.hex("#d97757")("Refine")} ${t.dim("— see available code")}`, value: "refine" },
          { name: `${t.dim("Cancel build")}`, value: "cancel" },
        ],
      });
      choice = answer ?? "cancel";
    } catch {
      console.log(`  ${t.num("1.")} Refine query ${t.dim("(see available code)")}`);
      console.log(`  ${t.num("2.")} Cancel build`);
      const text = await promptLine(`\n  ${t.brand(">")} `);
      choice = { "1": "refine", "2": "cancel" }[text] ?? "cancel";
    }

    if (choice === "refine") {
      await displayAvailableComponents(workingDir);
      console.log();
      const newQuery = await promptLine(`  ${t.brand(">")} New query ${t.dim("(or 'cancel')")}: `);
      if (!newQuery || newQuery.toLowerCase() === "cancel") {
        console.log(`\n  ${t.dim("Build cancelled.")}`);
        return [false, null];
      }
      return [true, newQuery];
    }

    console.log(`\n  ${t.dim("Build cancelled.")}`);
    return [false, null];
  }

  // Uncertain — 1-2 results
  sectionBox("Limited Context Found", "warn", [
    "",
    `${t.dim("Query:")} ${t.text(query)}`,
    "",
    `${t.dim(message)}:`,
    ...results.slice(0, 5).map((item) => {
      let fp = item.file;
      if (fp.startsWith(workingDir)) fp = fp.slice(workingDir.length).replace(/^[/\\]/, "");
      const icon = item.type === "function" ? t.brand("f") : item.type === "class" ? t.warn("C") : t.dim("-");
      return `  ${icon} ${t.text(item.name + "()")} ${t.dim("in")} ${t.path(fp)}`;
    }),
    "",
  ]);

  let choice: string;
  try {
    const { select } = await import("@inquirer/prompts");
    const answer = await select<string>({
      message: t.brand("What would you like to do?"),
      choices: [
        { name: `${chalk.hex("#4ade80")("Continue")} ${t.dim("— proceed with limited context")}`, value: "continue" },
        { name: `${chalk.hex("#d97757")("Refine")} ${t.dim("— see available code")}`, value: "refine" },
        { name: `${t.dim("Cancel build")}`, value: "cancel" },
      ],
    });
    choice = answer ?? "cancel";
  } catch {
    console.log(`  ${t.num("1.")} Continue anyway`);
    console.log(`  ${t.num("2.")} Refine query ${t.dim("(see available code)")}`);
    console.log(`  ${t.num("3.")} Cancel build`);
    const text = await promptLine(`\n  ${t.brand(">")} `);
    choice = { "1": "continue", "2": "refine", "3": "cancel" }[text] ?? "cancel";
  }

  if (choice === "continue") {
    stepInfo("Proceeding with limited context");
    return [true, null];
  }

  if (choice === "refine") {
    await displayAvailableComponents(workingDir);
    console.log();
    const newQuery = await promptLine(`  ${t.brand(">")} New query ${t.dim("(or 'cancel')")}: `);
    if (!newQuery || newQuery.toLowerCase() === "cancel") {
      console.log(`\n  ${t.dim("Build cancelled.")}`);
      return [false, null];
    }
    return [true, newQuery];
  }

  console.log(`\n  ${t.dim("Build cancelled.")}`);
  return [false, null];
}

async function displayAvailableComponents(workingDir: string): Promise<void> {
  const { getAvailableComponents } = await import("../builder/context-search.js");

  let components: AvailableComponents;
  try {
    components = await getAvailableComponents(workingDir, 15);
  } catch {
    console.log(`\n  ${t.dim("Could not load available components.")}`);
    return;
  }

  const lines: string[] = [];

  if (components.functions.length > 0) {
    lines.push(`${t.dim("Functions")} ${t.muted(`(${components.functions_total} total)`)}`);
    for (const fn of components.functions) {
      const sig = fn.signature ? t.dim(` ${fn.signature.slice(0, 50)}`) : "";
      lines.push(`  ${t.brand("f")} ${t.text(fn.name + "()")}${sig}  ${t.muted(fn.file)}`);
    }
    if (components.functions_total > components.functions.length) {
      lines.push(`  ${t.dim(`... and ${components.functions_total - components.functions.length} more`)}`);
    }
  }

  if (components.classes.length > 0) {
    if (lines.length) lines.push("");
    lines.push(`${t.dim("Classes")} ${t.muted(`(${components.classes_total} total)`)}`);
    for (const cls of components.classes) {
      lines.push(`  ${t.warn("C")} ${t.text(cls.name)}  ${t.muted(cls.file)}`);
    }
    if (components.classes_total > components.classes.length) {
      lines.push(`  ${t.dim(`... and ${components.classes_total - components.classes.length} more`)}`);
    }
  }

  if (lines.length === 0) {
    lines.push(t.dim(`No indexed components. Run ${t.cmd("synapse analyze")} first.`));
  }

  sectionBox("Available Code", "info", ["", ...lines, ""]);
}

// ---------------------------------------------------------------------------
// Build stages display
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<string, [string, string]> = {
  initializing: ["brand", "Initializing"],
  planning:     ["brand", "Planning MCP server"],
  task_list:    ["brand", "Compiling tasks"],
  generating:   ["brand", "Generating code"],
  complete:     ["ok",    "Generation complete"],
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runBuild(opts: BuildOptions): Promise<void> {
  const workingDir = process.cwd();
  const synapseDir = getProjectSynapseDir(workingDir);

  // 1. Init check
  if (!isInitialized(workingDir)) {
    sectionBox("Not Initialized", "err", [
      "Synapse is not initialized in this directory.",
      `Run ${t.cmd("synapse init")} first.`,
    ]);
    return;
  }

  // 2. Quota check
  const apiKey = resolveApiKey(workingDir) ?? "";
  if (apiKey) {
    try {
      const { checkQuota } = await import("../grpc/telemetry.js");
      const [exceeded, msg] = await checkQuota(apiKey);
      if (exceeded) { sectionBox("Quota Exceeded", "warn", [msg]); return; }
    } catch { /* fail open */ }
  }

  // Check analysis
  const schemaPath = getProjectSchemaPath(workingDir);
  if (!fs.existsSync(schemaPath)) {
    sectionBox("Analysis Required", "warn", [
      "Project schema not found.",
      `Run ${t.cmd("synapse analyze")} first.`,
    ]);
    return;
  }

  // 3. Register parser
  const { PythonParser } = await import("../parsers/python/index.js");
  const { registerParser } = await import("../parsers/registry.js");
  registerParser(new PythonParser());

  // 4. Auto-sync index
  const { ProgressIndicator } = await import("../ui/progress.js");
  const spinner = new ProgressIndicator();

  spinner.start("Syncing index");
  try {
    const { syncIndex } = await import("../indexer/code-indexer.js");
    const stats = await syncIndex(workingDir, synapseDir);
    spinner.complete(`Index synced  ${t.dim(`+${stats.added} ~${stats.updated} -${stats.deleted}`)}`);
  } catch (e) {
    spinner.fail(`Index sync failed: ${e}`);
  }

  // Handle --generate-only
  if (opts.generateOnly) {
    const todoPath = path.join(synapseDir, "todo_list.md");
    if (!fs.existsSync(todoPath)) {
      sectionBox("Missing Todo List", "err", [
        `Cannot use ${t.cmd("--generate")}: todo_list.md not found.`,
        `Run ${t.cmd("synapse build")} without --generate first.`,
      ]);
      return;
    }
    stepInfo("Generate mode", "using existing todo_list.md");
    const todoContent = fs.readFileSync(todoPath, "utf-8");
    return runGeneration(workingDir, schemaPath, opts, "Generate from existing todo_list.md", null, todoContent);
  }

  // 5. Scan codebase
  spinner.start("Scanning codebase");
  const { extractAllFunctions } = await import("../parsers/python/index.js");
  const allFunctions = extractAllFunctions(workingDir);
  spinner.complete(`Scanned codebase  ${t.dim(`${allFunctions.length} functions`)}`);

  // 6. Detect endpoints (cached)
  let candidates: _DetectedEndpointProxy[] = [];
  try {
    spinner.start("Discovering tool candidates");
    const projectSchema = fs.readFileSync(schemaPath, "utf-8");
    const cachePath = getEndpointsCachePath(workingDir);
    const { detectWithCache } = await import("../builder/detection-cache.js");
    const [rawCandidates, newDetectCount] = await detectWithCache(allFunctions, workingDir, projectSchema, cachePath);
    candidates = rawCandidates.map((c) => new _DetectedEndpointProxy(c, workingDir));
    spinner.complete(`Found ${t.num(String(candidates.length))} tool candidates`);

    // Telemetry: detect event (only if new detections occurred)
    if (newDetectCount > 0 && apiKey) {
      try {
        const { trackEvent } = await import("../grpc/telemetry.js");
        trackEvent("detect", apiKey, workingDir, 0, 0, newDetectCount).catch(() => {});
      } catch { /* optional */ }
    }
  } catch (e) {
    spinner.fail(`Discovery error: ${e}`);
  }

  // 7. Interactive endpoint selection
  let selectedEndpoints: _DetectedEndpointProxy[] = [];
  let customSelected = false;
  let finalQuery: string | undefined = opts.query;

  if (finalQuery) {
    stepBrand("Using provided query", `"${finalQuery}"`);
  } else if (candidates.length > 0) {
    try {
      const { selectEndpoints } = await import("../ui/endpoint-selector.js");
      const candidateChoices = candidates.map((c) => c.toEndpointCandidate(workingDir));
      const result = await selectEndpoints(candidateChoices);
      customSelected = result.customSelected;
      const selectedNames = new Set(result.selected.map((s) => s.name));
      selectedEndpoints = candidates.filter((c) => selectedNames.has(c.name));

      if (!selectedEndpoints.length && !customSelected) {
        stepWarn("No selection made", "switching to custom mode");
        customSelected = true;
      }
    } catch (e) {
      stepWarn("Interactive selection failed", String(e));
      selectedEndpoints = candidates.filter((c) => c.confidence >= 0.7);
      if (!selectedEndpoints.length) {
        selectedEndpoints = candidates.filter((c) => c.confidence >= 0.5);
      }
    }
  } else {
    stepInfo("No candidates detected", "switching to custom query mode");
    customSelected = true;
  }

  // 8. Build query from selections + custom combining
  if (selectedEndpoints.length > 0) {
    const descs = selectedEndpoints.map((ep) => formatEndpointForPlanner(ep, workingDir));
    const autoQuery = "Create MCP tools for the following endpoints:\n\n" + descs.join("\n\n");

    console.log();
    console.log(`  ${t.brandBold(`${selectedEndpoints.length} endpoint(s) selected`)}`);
    for (const ep of selectedEndpoints) {
      const rel = path.relative(workingDir, ep.filePath);
      console.log(`  ${t.brand(">")} ${t.text(ep.name + "()")} ${t.dim("in")} ${t.path(rel)}`);
    }

    if (customSelected && !opts.query) {
      console.log(`\n  ${t.dim("You also selected Custom Requirement.")}`);
      const additional = await promptLine(`  ${t.brand(">")} Additional requirements ${t.dim("(Enter to skip)")}: `);

      if (additional.trim()) {
        spinner.start("Validating custom requirements");
        const { validateQueryRelevance } = await import("../builder/context-search.js");
        const customValidation = await validateQueryRelevance(additional, workingDir);
        spinner.stop();

        if (customValidation.status === "insufficient") {
          sectionBox("Custom Requirements Not Found", "err", [
            "",
            `${t.dim("Requirement:")} ${t.text(additional)}`,
            "",
            t.dim("No matching code found. The selected endpoints exist,"),
            t.dim("but your custom requirements don't match any code."),
            "",
            `${t.dim("Try:")} ${t.cmd("synapse build")} ${t.dim("and select only endpoints.")}`,
            "",
          ]);
          return;
        } else if (customValidation.status === "uncertain") {
          stepWarn("Limited matches for custom requirements", `${customValidation.high_quality_results} found`);
        } else {
          stepOk("Custom requirements validated");
        }

        finalQuery = autoQuery + "\n\nAdditional requirements:\n" + additional;
      } else {
        finalQuery = autoQuery;
      }
    } else {
      finalQuery = opts.query ?? autoQuery;
    }
  } else if (customSelected) {
    if (!opts.query) {
      console.log();
      console.log(`  ${t.brandBold("Describe your MCP server requirements")}`);
      console.log(`  ${t.dim("Be specific about the functionality to expose.")}`);
      console.log();
      console.log(`  ${t.dim("Examples:")}`);
      console.log(`    ${t.muted("\"Create tools for file operations and directory listing\"")}`);
      console.log(`    ${t.muted("\"Expose database query and data retrieval functions\"")}`);
      console.log();

      finalQuery = await promptLine(`  ${t.brand(">")} `);
      if (!finalQuery || finalQuery.trim().length < 10) {
        sectionBox("Query Too Short", "warn", [
          "Please provide at least 10 characters.",
        ]);
        return;
      }
    } else {
      finalQuery = opts.query;
    }
  }

  if (!finalQuery) {
    sectionBox("No Input", "warn", [
      "No endpoints selected and no query provided.",
      `Use ${t.cmd("synapse build --query '<requirements>'")}`,
    ]);
    return;
  }

  // 9. Query validation loop
  const { validateQueryRelevance } = await import("../builder/context-search.js");

  while (true) {
    const validation = await validateQueryRelevance(finalQuery, workingDir);
    const [shouldProceed, newQuery] = await displayContextValidationUI(validation, workingDir);
    if (!shouldProceed) return;
    if (newQuery) { finalQuery = newQuery; continue; }
    break;
  }

  // 10. Build context bundle
  let contextBundle: Record<string, unknown> | null = null;

  if (selectedEndpoints.length > 0) {
    try {
      spinner.start("Building context bundle");
      const { buildContextBundle } = await import("../builder/context-builder.js");
      contextBundle = buildContextBundle(
        selectedEndpoints.map((ep) => ({
          name: ep.name,
          file_path: path.relative(workingDir, ep.filePath),
          signature: ep.signature, docstring: ep.docstring,
          return_type: ep.returnType, conversion_type: ep.conversionType,
          client_dependency: ep.clientDependency,
        })),
        workingDir, synapseDir,
      ) as Record<string, unknown>;
      spinner.complete("Context bundle ready");
    } catch (e) {
      spinner.fail(`Context bundle error: ${e}`);
    }
  } else {
    try {
      spinner.start("Expanding query and building context");
      const { buildContextBundleFromQuery } = await import("../builder/query-expander.js");
      const resolvedKey = resolveApiKey(workingDir) ?? "";
      contextBundle = (await buildContextBundleFromQuery(
        finalQuery, workingDir, synapseDir, undefined, resolvedKey,
      )) as Record<string, unknown>;
      spinner.complete("Context bundle ready");
    } catch (e) {
      spinner.fail(`Query expansion error: ${e}`);
    }
  }

  // 11. Inject CONTEXT.md
  if (contextBundle) {
    const contextMdPath = getContextMdPath(workingDir);
    if (fs.existsSync(contextMdPath)) {
      try {
        contextBundle.project_context = fs.readFileSync(contextMdPath, "utf-8");
        stepOk("Loaded project context", ".synapse/CONTEXT.md");
      } catch { /* non-fatal */ }
    }
  }

  // 12. Generation
  return runGeneration(workingDir, schemaPath, opts, finalQuery, contextBundle, null);
}

// ---------------------------------------------------------------------------
// Generation subroutine
// ---------------------------------------------------------------------------

async function runGeneration(
  workingDir: string,
  schemaPath: string,
  opts: BuildOptions,
  query: string,
  contextBundle: Record<string, unknown> | null,
  todoListContent: string | null,
): Promise<void> {
  const projectSchema = fs.readFileSync(schemaPath, "utf-8");
  let currentStage = "";

  sectionHeader("Building MCP Server");

  const { CodeGenerationUI } = await import("../ui/code-gen-ui.js");
  const state = { genUI: null as InstanceType<typeof CodeGenerationUI> | null };
  const genStartTime = Date.now();

  const onStatus = (stage: string, _message: string, _progress: number) => {
    const s = stage.toLowerCase();
    if (s === currentStage) return;
    currentStage = s;

    if (s === "generating" && !state.genUI) {
      state.genUI = new CodeGenerationUI();
      state.genUI.start(genStartTime);
      return;
    }

    if (s === "complete" && state.genUI) {
      state.genUI.complete();
      state.genUI = null;
      return;
    }

    if (state.genUI) return;

    const entry = STAGE_LABELS[s];
    if (entry) {
      const [color, label] = entry;
      if (color === "ok") {
        stepOk(label);
      } else {
        stepBrand(label);
      }
    } else {
      stepBrand(stage);
    }
  };

  const onToolCall = (_toolName: string, _result: unknown) => {
    // Tool calls are silent during generation UI animation
  };

  console.log();

  try {
    const { SynapseClient } = await import("../grpc/client.js");
    const backend = getBackendConfig();
    const client = new SynapseClient({
      url: backend.url ?? undefined,
      host: backend.host ?? undefined,
      workingDir,
    });

    const result = await client.build({
      query, projectSchema,
      outputFile: opts.output, validate: opts.validate,
      docs: opts.docs, generateOnly: opts.generateOnly,
      todoListContent: todoListContent ?? undefined,
      contextBundle: contextBundle ?? undefined,
      callbacks: { onStatus, onToolCall },
    });

    if (state.genUI) {
      state.genUI.stop();
      state.genUI = null;
    }

    if (!result.success) {
      sectionBox("Build Failed", "err", [
        result.error ?? "Unknown error",
      ]);
      return;
    }

    // Telemetry: build event
    const toolCount = result.toolCount ?? 0;
    if (toolCount > 0) {
      try {
        const resolvedKey = resolveApiKey(workingDir) ?? "";
        if (resolvedKey) {
          const { trackEvent } = await import("../grpc/telemetry.js");
          const durationMs = Date.now() - genStartTime;
          trackEvent("build", resolvedKey, workingDir, 0, toolCount, 0, durationMs).catch(() => {});
        }
      } catch { /* optional */ }
    }

    // Write output
    if (result.serverCode) {
      fs.writeFileSync(path.join(workingDir, opts.output), result.serverCode, "utf-8");
    }

    // Success display
    const absOutput = path.resolve(workingDir, opts.output);
    const configSnippet = JSON.stringify({
      mcpServers: { "custom-server": { command: "python", args: [absOutput] } },
    }, null, 2);

    sectionBox("MCP Server Generated", "ok", [
      "",
      `${t.dim("Tools")}       ${t.num(String(result.toolCount ?? 0))}`,
      `${t.dim("Resources")}   ${t.num(String(result.resourceCount ?? 0))}`,
      `${t.dim("Output")}      ${t.path(opts.output)}`,
      "",
      `${t.dim("Next steps:")}`,
      `  ${t.num("1.")} Review the generated server code`,
      `  ${t.num("2.")} ${t.cmd("pip install mcp")}`,
      `  ${t.num("3.")} ${t.cmd(`python ${opts.output}`)}`,
      "",
      `${t.dim("MCP client config:")}`,
      ...configSnippet.split("\n").map((line) => `  ${t.muted(line)}`),
      "",
    ]);
  } catch (e) {
    if (state.genUI) {
      state.genUI.stop();
      state.genUI = null;
    }
    sectionBox("Build Error", "err", [String(e)]);
  }
}
