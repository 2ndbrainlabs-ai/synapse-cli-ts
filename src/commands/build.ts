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

  spinner.complete("Ready");

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

  // 5. Discover use cases via exploratory agent
  const projectSchema = fs.readFileSync(schemaPath, "utf-8");

  interface DiscoveredUseCase { title: string; description: string; functions: string[]; module: string; }
  let useCases: DiscoveredUseCase[] = [];
  let finalQuery: string | undefined = opts.query;

  if (!finalQuery) {
    const discoverStart = Date.now();
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frameIdx = 0;
    let lastLen = 0;
    let toolCalls = 0;

    const fmtTime = (ms: number) => {
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return `${secs}s`;
      return `${Math.floor(secs / 60)}m ${secs % 60}s`;
    };

    const discoverInterval = setInterval(() => {
      frameIdx = (frameIdx + 1) % frames.length;
      const elapsed = fmtTime(Date.now() - discoverStart);
      const calls = toolCalls > 0 ? `  ${t.num(`${toolCalls} calls`)}` : "";
      const line = `  ${t.brand(frames[frameIdx])}  Exploring codebase  ${t.dim(elapsed)}${calls}`;
      const plainLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
      process.stdout.write(`\r${" ".repeat(lastLen + 2)}\r${line}`);
      lastLen = plainLen;
    }, 80);

    try {
      const { SynapseClient } = await import("../grpc/client.js");
      const backend = getBackendConfig();
      const client = new SynapseClient({
        url: backend.url ?? undefined,
        host: backend.host ?? undefined,
        port: backend.port ? parseInt(backend.port, 10) : undefined,
        workingDir,
      });

      const result = await client.discoverUseCases(projectSchema, (info) => {
        toolCalls = info.toolCalls;
      });

      clearInterval(discoverInterval);
      process.stdout.write(`\r${" ".repeat(lastLen + 2)}\r`);

      if (result.error) {
        console.log(`  ${t.warn("!")}  Discovery failed: ${result.error}`);
      } else {
        useCases = result.useCases;
        console.log(`  ${t.ok("✓")}  Discovered ${t.num(String(useCases.length))} use cases  ${t.dim(fmtTime(Date.now() - discoverStart))}`);
      }
    } catch (e) {
      clearInterval(discoverInterval);
      process.stdout.write(`\r${" ".repeat(lastLen + 2)}\r`);
      console.log(`  ${t.warn("!")}  Discovery error: ${e}`);
    }
  }

  // 6. Use case selection
  let customSelected = false;

  if (finalQuery) {
    stepBrand("Using provided query", `"${finalQuery}"`);
  } else if (useCases.length > 0) {
    try {
      const { checkbox } = await import("@inquirer/prompts");
      const chalk = (await import("chalk")).default;

      sectionHeader("Select Use Cases");
      console.log();

      const choices = [
        {
          name: `${chalk.hex("#a5b4fc").bold("Custom requirement")} ${t.dim("— describe what you need")}`,
          value: "__CUSTOM__",
          checked: false,
        },
        ...useCases.map((uc, i) => ({
          name: `${chalk.hex("#d97757").bold(uc.title)} ${t.dim("—")} ${t.text(uc.description)}  ${t.muted(`(${uc.functions.length} functions)`)}`,
          value: String(i),
          checked: false,
        })),
      ];

      const selected = await checkbox<string>({
        message: t.brand("Choose use cases to build as MCP tools:"),
        choices,
        loop: false,
      });

      customSelected = selected.includes("__CUSTOM__");
      const selectedUseCases = selected
        .filter((v) => v !== "__CUSTOM__")
        .map((v) => useCases[parseInt(v, 10)]);

      if (selectedUseCases.length > 0) {
        console.log();
        console.log(`  ${t.brandBold(`${selectedUseCases.length} use case(s) selected`)}`);
        for (const uc of selectedUseCases) {
          console.log(`  ${t.brand(">")} ${t.text(uc.title)} ${t.dim(`(${uc.functions.join(", ")})`)}`);
        }

        // Build a query from selected use cases
        const ucDescs = selectedUseCases.map((uc) =>
          `- ${uc.title}: ${uc.description} (functions: ${uc.functions.join(", ")})`
        );
        finalQuery = "Create MCP tools for the following use cases:\n\n" + ucDescs.join("\n");
      } else if (!customSelected) {
        stepWarn("No selection made", "switching to custom mode");
        customSelected = true;
      }
    } catch (e) {
      stepWarn("Interactive selection failed", String(e));
      // Fallback: build for all use cases
      const allFuncs = useCases.flatMap((uc) => uc.functions);
      finalQuery = `Create MCP tools wrapping: ${allFuncs.slice(0, 10).join(", ")}`;
    }
  } else {
    stepInfo("No use cases discovered", "switching to custom query mode");
    customSelected = true;
  }

  // 7. Custom query prompt (if no use case selected and no --query)
  if (customSelected && !finalQuery) {
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
  }

  if (!finalQuery) {
    sectionBox("No Input", "warn", [
      "No use cases selected and no query provided.",
      `Use ${t.cmd("synapse build --query '<requirements>'")}`,
    ]);
    return;
  }

  // 8. Build context bundle (custom query mode — let backend retrieve)
  let contextBundle: Record<string, unknown> | null = null;
  contextBundle = { endpoints: [], project_name: path.basename(workingDir), mode: "custom_prompt" };
  stepOk("Ready", "backend will explore and build");

  // Inject CONTEXT.md if available
  const contextMdPath = getContextMdPath(workingDir);
  if (fs.existsSync(contextMdPath)) {
    try {
      contextBundle.project_context = fs.readFileSync(contextMdPath, "utf-8");
    } catch { /* non-fatal */ }
  }

  // 9. Generation
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

  const { BuildProgressUI } = await import("../ui/build-progress.js");
  const state = { progress: null as InstanceType<typeof BuildProgressUI> | null };
  const genStartTime = Date.now();

  const STAGE_DISPLAY: Record<string, string> = {
    retrieving: "Analyzing codebase",
    generating: "Generating code",
    verifying: "Verifying output",
    planning: "Planning",
    initializing: "Initializing",
  };

  const onStatus = (stage: string, _message: string, _progress: number) => {
    const s = stage.toLowerCase();
    if (s === currentStage) return;
    currentStage = s;

    if (!state.progress && s !== "complete") {
      state.progress = new BuildProgressUI();
      state.progress.start(genStartTime);
    }

    if (s === "complete" && state.progress) {
      state.progress.complete();
      state.progress = null;
      return;
    }

    if (state.progress) {
      state.progress.updateStage(STAGE_DISPLAY[s] || s);
    }
  };

  const onToolCall = (_toolName: string, _result: unknown) => {
    if (state.progress) {
      state.progress.incrementToolCalls();
    }
  };

  console.log();

  try {
    const { SynapseClient } = await import("../grpc/client.js");
    const backend = getBackendConfig();
    const client = new SynapseClient({
      url: backend.url ?? undefined,
      host: backend.host ?? undefined,
      port: backend.port ? parseInt(backend.port, 10) : undefined,
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

    if (state.progress) {
      state.progress.complete();
      state.progress = null;
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

    // Detect required env vars from generated code
    const envVarMatches = (result.serverCode ?? "").matchAll(/os\.getenv\(["']([A-Z_][A-Z0-9_]*)["']/g);
    const envVars = [...new Set([...envVarMatches].map((m) => m[1]))];

    // Build MCP config with env vars included
    const mcpServerConfig: Record<string, unknown> = {
      command: "python",
      args: [absOutput],
    };
    if (envVars.length > 0) {
      const envObj: Record<string, string> = {};
      for (const v of envVars) envObj[v] = "";
      mcpServerConfig.env = envObj;
    }
    const configSnippet = JSON.stringify({ mcpServers: { "custom-server": mcpServerConfig } }, null, 2);

    const lines = [
      "",
      `${t.dim("Tools")}       ${t.num(String(result.toolCount ?? 0))}`,
      `${t.dim("Resources")}   ${t.num(String(result.resourceCount ?? 0))}`,
      `${t.dim("Output")}      ${t.path(opts.output)}`,
      "",
    ];

    if (envVars.length > 0) {
      lines.push(`${t.dim("Required environment variables:")}`);
      for (const v of envVars) {
        lines.push(`  ${t.warn("•")} ${t.cmd(v)}`);
      }
      lines.push(`  ${t.dim("Set these in a .env file or export them before running the server.")}`);
      lines.push("");
    }

    lines.push(
      `${t.dim("Next steps:")}`,
      `  ${t.num("1.")} Review the generated server code`,
      `  ${t.num("2.")} ${t.cmd("pip install mcp")}`,
      `  ${t.num("3.")} ${t.cmd(`python ${opts.output}`)}`,
      "",
      `${t.dim("MCP client config:")}`,
      ...configSnippet.split("\n").map((line) => `  ${t.muted(line)}`),
      "",
    );

    sectionBox("MCP Server Generated", "ok", lines);
  } catch (e) {
    if (state.progress) {
      state.progress.stop();
      state.progress = null;
    }
    sectionBox("Build Error", "err", [String(e)]);
  }
}
