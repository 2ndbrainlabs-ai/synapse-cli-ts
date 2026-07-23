/**
 * `synapse build` — MCP server generation command.
 *
 * Flow:
 *   1. Verify project is initialized and analyzed
 *   2. Discover use cases via exploratory agent (unless --query provided)
 *   3. Let user select use cases (or type custom query)
 *   4. Stream generation over the Build RPC — orbital spinner + PRO TIP box
 *   5. Write output + show a rounded success panel + copy-paste MCP config
 */

import fs from "node:fs";
import path from "node:path";
import {
  isInitialized,
  resolveApiKey,
  getBackendConfig,
} from "../config/manager.js";
import {
  getProjectSynapseDir,
  getProjectSchemaPath,
  getContextMdPath,
} from "../config/paths.js";
import { t, stepOk, stepWarn, stepInfo, stepBrand, sectionHeader } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";
import { Spinner } from "../ui/spinner.js";
import { CodeGenerationUI } from "../ui/code-gen-ui.js";
import { selectUseCases, type UseCaseChoice } from "../ui/endpoint-selector.js";
import { styledInput } from "../ui/styled-input.js";
import { pickVerb } from "../ui/verbs.js";
import { BULLET } from "../ui/icons.js";
import { ToolActivity } from "../ui/tool-activity.js";

export interface BuildOptions {
  query?: string;
  output: string;
  validate: boolean;
  docs: boolean;
  generateOnly: boolean;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runBuild(opts: BuildOptions): Promise<void> {
  const workingDir = process.cwd();
  const synapseDir = getProjectSynapseDir(workingDir);

  // 1. Init check
  if (!isInitialized(workingDir)) {
    roundedBox("Not Initialized", "✖", t.err, [
      "Synapse is not initialized in this directory.",
      "",
      `Run ${t.cmd("synapse init")} first.`,
    ]);
    return;
  }

  // 2. Quota check (best-effort)
  const apiKey = resolveApiKey(workingDir) ?? "";
  if (apiKey) {
    try {
      const { checkQuota } = await import("../grpc/telemetry.js");
      const [exceeded, msg] = await checkQuota(apiKey);
      if (exceeded) {
        roundedBox("Quota Exceeded", "⚠", t.warn, [msg]);
        return;
      }
    } catch {
      /* fail open */
    }
  }

  // 3. Analysis check
  const schemaPath = getProjectSchemaPath(workingDir);
  if (!fs.existsSync(schemaPath)) {
    roundedBox("Analysis Required", "⚠", t.warn, [
      "Project schema not found.",
      "",
      `Run ${t.cmd("synapse analyze")} first.`,
    ]);
    return;
  }

  // 4. Register parser
  const { PythonParser } = await import("../parsers/python/index.js");
  const { registerParser } = await import("../parsers/registry.js");
  registerParser(new PythonParser());

  sectionHeader("Build MCP Server", "🏗️");

  // 5. Handle --generate-only
  if (opts.generateOnly) {
    const todoPath = path.join(synapseDir, "todo_list.md");
    if (!fs.existsSync(todoPath)) {
      roundedBox("Missing Todo List", "✖", t.err, [
        `Cannot use ${t.cmd("--generate")}: todo_list.md not found.`,
        `Run ${t.cmd("synapse build")} without --generate first.`,
      ]);
      return;
    }
    stepInfo("Generate mode", "using existing todo_list.md");
    const todoContent = fs.readFileSync(todoPath, "utf-8");
    return runGeneration(
      workingDir,
      schemaPath,
      opts,
      "Generate from existing todo_list.md",
      null,
      todoContent,
    );
  }

  // 6. Discover use cases (agentic) — unless --query provided
  const projectSchema = fs.readFileSync(schemaPath, "utf-8");
  let useCases: UseCaseChoice[] = [];
  let finalQuery: string | undefined = opts.query;

  if (!finalQuery) {
    const spinner = new Spinner("orbital");
    const activity = new ToolActivity();
    spinner.start(`${pickVerb()} your codebase`);

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
        // Only tool_request events carry a toolName — status ticks arrive without one.
        if (info.toolName) activity.record(info.toolName);
        spinner.updateMeta({ extra: activity.format() });
      });

      if (result.error) {
        spinner.fail("Discovery failed", result.error);
      } else {
        useCases = result.useCases;
        spinner.complete(
          `Discovered ${useCases.length} ${useCases.length === 1 ? "use case" : "use cases"}`,
        );
      }
    } catch (e) {
      spinner.fail("Discovery error", String(e));
    }
  }

  // 7. Use case selection
  let customSelected = false;

  if (finalQuery) {
    stepBrand("Using provided query", `"${finalQuery}"`);
  } else if (useCases.length > 0) {
    const { selected, customSelected: cs } = await selectUseCases(useCases);
    customSelected = cs;

    if (selected.length > 0) {
      console.log();
      console.log(`  ${t.brandBold(`${selected.length} use case(s) selected`)}`);
      for (const uc of selected) {
        console.log(`  ${t.brand("›")} ${t.text(uc.title)} ${t.dim(`(${uc.functions.join(", ")})`)}`);
      }

      const ucDescs = selected.map(
        (uc) =>
          `- ${uc.title}: ${uc.description} (functions: ${uc.functions.join(", ")})`,
      );
      finalQuery = "Create MCP tools for the following use cases:\n\n" + ucDescs.join("\n");
    } else if (!customSelected) {
      stepWarn("No selection made", "switching to custom mode");
      customSelected = true;
    }
  } else {
    stepInfo("No use cases discovered", "switching to custom query mode");
    customSelected = true;
  }

  // 8. Custom query prompt
  if (customSelected && !finalQuery) {
    console.log();
    console.log(`  ${t.brandBold("Describe your MCP server requirements")}`);
    console.log(`  ${t.dim("Be specific about the functionality to expose.")}`);
    console.log();
    console.log(`  ${t.dim("Examples:")}`);
    console.log(`    ${t.subtle('"Create tools for file operations and directory listing"')}`);
    console.log(`    ${t.subtle('"Expose database query and data retrieval functions"')}`);
    console.log();

    finalQuery = await styledInput({
      message: "Requirements",
      placeholder: "e.g. Create tools for user auth and profile management",
    });

    if (!finalQuery || finalQuery.trim().length < 10) {
      roundedBox("Query Too Short", "⚠", t.warn, [
        "Please provide at least 10 characters.",
      ]);
      return;
    }
  }

  if (!finalQuery) {
    roundedBox("No Input", "⚠", t.warn, [
      "No use cases selected and no query provided.",
      "",
      `Use ${t.cmd("synapse build --query '<requirements>'")}`,
    ]);
    return;
  }

  // 9. Build context bundle (empty — backend does agentic retrieval)
  const contextBundle: Record<string, unknown> = {
    endpoints: [],
    project_name: path.basename(workingDir),
    mode: "custom_prompt",
  };

  // Inject CONTEXT.md if available
  const contextMdPath = getContextMdPath(workingDir);
  if (fs.existsSync(contextMdPath)) {
    try {
      contextBundle.project_context = fs.readFileSync(contextMdPath, "utf-8");
    } catch {
      /* non-fatal */
    }
  }

  // 10. Generation
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

  sectionHeader("Generating", "⚡");

  // Two-phase progress: a Spinner for pre-generation stages (retrieve, verify)
  // and CodeGenerationUI once the "generating" stage begins.
  const state = {
    spinner: null as Spinner | null,
    genUI: null as CodeGenerationUI | null,
    activity: new ToolActivity(),
  };
  const genStartTime = Date.now();

  const STAGE_DISPLAY: Record<string, string> = {
    retrieving: "Exploring codebase",
    generating: "Generating MCP server",
    verifying: "Verifying output",
    planning: "Planning",
    initializing: "Initializing",
    exploring: "Exploring codebase",
    retrying: "Network congested — retrying on backup model",
  };

  const onStatus = (stage: string, _message: string, _progress: number) => {
    const s = stage.toLowerCase();
    if (s === currentStage) return;
    currentStage = s;

    // Complete signal from backend — clean up whatever's running
    if (s === "complete") {
      if (state.genUI) {
        state.genUI.complete();
        state.genUI = null;
      } else if (state.spinner) {
        state.spinner.complete();
        state.spinner = null;
      }
      return;
    }

    // Transition to CodeGenerationUI once actual generation starts
    if (s === "generating" && !state.genUI) {
      if (state.spinner) {
        state.spinner.stop();
        state.spinner = null;
      }
      state.genUI = new CodeGenerationUI();
      state.genUI.start(genStartTime);
      return;
    }

    // Pre-generation stages use the plain orbital spinner
    if (!state.genUI) {
      if (!state.spinner) {
        state.spinner = new Spinner("orbital");
        state.spinner.resetTimer();
        state.spinner.start(STAGE_DISPLAY[s] ?? s);
      } else {
        state.spinner.updateMessage(STAGE_DISPLAY[s] ?? s);
      }
    }
  };

  const onToolCall = (toolName: string, _result: unknown) => {
    state.activity.record(toolName);
    if (state.spinner) {
      state.spinner.updateMeta({ extra: state.activity.format() });
    }
  };

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
      query,
      projectSchema,
      outputFile: opts.output,
      validate: opts.validate,
      docs: opts.docs,
      generateOnly: opts.generateOnly,
      todoListContent: todoListContent ?? undefined,
      contextBundle: contextBundle ?? undefined,
      callbacks: { onStatus, onToolCall },
    });

    // Ensure UIs are stopped
    if (state.genUI) {
      state.genUI.complete();
      state.genUI = null;
    }
    if (state.spinner) {
      state.spinner.complete();
      state.spinner = null;
    }

    if (!result.success) {
      roundedBox("Build Failed", "✖", t.err, [
        result.error ?? "Unknown error",
      ]);
      return;
    }

    // Telemetry
    const toolCount = result.toolCount ?? 0;
    if (toolCount > 0) {
      try {
        const resolvedKey = resolveApiKey(workingDir) ?? "";
        if (resolvedKey) {
          const { trackEvent } = await import("../grpc/telemetry.js");
          const durationMs = Date.now() - genStartTime;
          trackEvent("build", resolvedKey, workingDir, 0, toolCount, 0, durationMs).catch(
            () => {},
          );
        }
      } catch {
        /* optional */
      }
    }

    // Write output
    if (result.serverCode) {
      fs.writeFileSync(
        path.join(workingDir, opts.output),
        result.serverCode,
        "utf-8",
      );
    }

    // Detect env vars from generated code
    const envVarMatches = (result.serverCode ?? "").matchAll(
      /os\.getenv\(["']([A-Z_][A-Z0-9_]*)["']/g,
    );
    const envVars = [...new Set([...envVarMatches].map((m) => m[1]))];

    // Success box
    const boxLines: string[] = [];
    boxLines.push(`${t.dim("Tools:")}     ${t.num(String(result.toolCount ?? 0))}`);
    boxLines.push(`${t.dim("Resources:")} ${t.num(String(result.resourceCount ?? 0))}`);
    boxLines.push(`${t.dim("Output:")}    ${t.path(opts.output)}`);
    // Session id — quote this when reporting an issue; matches Langfuse trace.
    if ((result as any).sessionId) {
      boxLines.push(`${t.dim("Session:")}   ${t.subtle((result as any).sessionId)}`);
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
    boxLines.push(`  ${t.num("1.")} Review the generated server code`);
    boxLines.push(`  ${t.num("2.")} ${t.cmd("pip install mcp")}`);
    boxLines.push(`  ${t.num("3.")} ${t.cmd(`python ${opts.output}`)}`);

    console.log();
    roundedBox("MCP Server Generated", "✓", t.ok, boxLines);

    // MCP client config — printed outside the box, copy-paste friendly
    const absOutput = path.resolve(workingDir, opts.output);
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
      { mcpServers: { "custom-server": mcpServerConfig } },
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

    // Env var reminder — outside the box, more visible
    if (envVars.length > 0) {
      stepWarn(
        `Set ${envVars.length} environment variable${envVars.length === 1 ? "" : "s"} before running:`,
        envVars.join(", "),
      );
      console.log();
    }
    stepOk("Done");
  } catch (e) {
    if (state.genUI) {
      state.genUI.stop();
      state.genUI = null;
    }
    if (state.spinner) {
      state.spinner.stop();
      state.spinner = null;
    }
    roundedBox("Build Error", "✖", t.err, [String(e)]);
  }
}
