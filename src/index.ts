import { config as loadDotenv } from "dotenv";
loadDotenv();

import { createRequire } from "node:module";
import { Command } from "commander";

// Suppress gRPC logging before any grpc imports
process.env.GRPC_VERBOSITY = "ERROR";
process.env.GRPC_TRACE = "";
process.env.GRPC_ENABLE_FORK_SUPPORT = "0";

// ---------------------------------------------------------------------------
// Clean-exit handlers: Ctrl-C / Esc during an @inquirer/prompts question
// throws ExitPromptError as an unhandled rejection, which prints a scary
// Node stack trace. Users should see one friendly line and exit 0.
//
// SIGINT outside a prompt (e.g. mid-extraction) is handled per-command via
// SessionManager; the guard here only fires if that hasn't caught it.
// ---------------------------------------------------------------------------
function isUserAbortError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { name?: string; message?: string; code?: string };
  return (
    anyErr.name === "ExitPromptError" ||
    anyErr.code === "ABORT_ERR" ||
    (typeof anyErr.message === "string" &&
      (anyErr.message.includes("SIGINT") ||
        anyErr.message.includes("force closed the prompt")))
  );
}

function printFriendlyCancel(): void {
  // Small friendly nudge — matches the tone of the success box.
  process.stdout.write("\n  \x1b[2m✖ Cancelled. Run \x1b[0m\x1b[36msynapse build\x1b[0m\x1b[2m again to retry.\x1b[0m\n\n");
}

process.on("uncaughtException", (err) => {
  if (isUserAbortError(err)) {
    printFriendlyCancel();
    process.exit(0);
  }
  // Anything else: preserve default Node behavior.
  console.error(err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (isUserAbortError(reason)) {
    printFriendlyCancel();
    process.exit(0);
  }
  console.error(reason);
  process.exit(1);
});

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const program = new Command();

program
  .name("synapse")
  .description("Synapse - Agentic MCP Server Generator")
  .version(pkg.version)
  .option("--dev", "Use local backend (localhost:50051)");

// Show dev mode notice
if (process.argv.includes("--dev") || process.env.SYNAPSE_DEV === "1") {
  console.log("  \x1b[33m⚡ Dev mode: using localhost:50051\x1b[0m\n");
}

program
  .command("init")
  .description("Initialize Synapse in the current directory")
  .option("--force", "Force re-initialization")
  .action(async (opts) => {
    const { runInit } = await import("./commands/init.js");
    await runInit(opts.force ?? false);
  });

program
  .command("analyze")
  .description("Analyze codebase and generate project schema")
  .option("-o, --output <dir>", "Output directory for analysis", ".synapse")
  .option("-v, --verbose", "Verbose output")
  .action(async (opts) => {
    const { runAnalyze } = await import("./commands/analyze.js");
    await runAnalyze(opts.output, opts.verbose ?? false);
  });

program
  .command("build")
  .description("Build MCP server based on requirements")
  .option("-q, --query <query>", "MCP server requirements (v1) / workflow intent (v2 custom)")
  .option("-o, --output <file>", "Output file for generated server (v1 only)", "mcp_server.py")
  .option("--no-validate", "Skip validation step")
  .option("--no-docs", "Skip documentation step")
  .option("-g, --generate", "Skip planner and use existing todo_list.md")
  // v2 flags
  .option("--engine <version>", "Build engine: 'v2' (default, two-track) or 'v1' (legacy agent loop)", "v2")
  .option("--auto", "v2: force Auto track (expose HTTP endpoints via runner)")
  .option("--custom", "v2: force Custom track (compose internal functions)")
  .option("--base-url <url>", "v2 auto: deployed base URL for the API")
  .option("--server-name <name>", "v2 auto: name for the created MCP server")
  .option("--resume", "v2: resume the most recent unfinished discover session for this repo")
  .option("--max-time <minutes>", "v2: soft wall-clock cap in minutes (default 15)")
  .option("--deep", "v2 custom: raise candidate cap from 200 to 500 during classification")
  .action(async (opts) => {
    if (opts.engine === "v2") {
      const { runBuildV2 } = await import("./commands/v2/build-v2.js");
      const maxTimeMinutes = opts.maxTime ? Number(opts.maxTime) : undefined;
      await runBuildV2({
        auto: opts.auto ?? false,
        custom: opts.custom ?? false,
        query: opts.query,
        baseUrl: opts.baseUrl,
        serverName: opts.serverName,
        resume: opts.resume ?? false,
        maxTimeMinutes: Number.isFinite(maxTimeMinutes) ? (maxTimeMinutes as number) : undefined,
        deep: opts.deep ?? false,
      });
      return;
    }
    const { runBuild } = await import("./commands/build.js");
    await runBuild({
      query: opts.query,
      output: opts.output,
      validate: opts.validate,
      docs: opts.docs,
      generateOnly: opts.generate ?? false,
    });
  });

program
  .command("config")
  .description("View or update Synapse configuration")
  .option("--update", "Update configuration interactively")
  .option("--key <apiKey>", "Set API key")
  .option("--global", "Apply --key to global config (~/.synapse)")
  .action(async (opts) => {
    const { runConfig } = await import("./commands/config.js");
    await runConfig({
      update: opts.update ?? false,
      apiKey: opts.key,
      globalScope: opts.global ?? false,
    });
  });

program
  .command("info")
  .description("Show Synapse project information and account quota")
  .action(async () => {
    const { runInfo } = await import("./commands/info.js");
    await runInfo();
  });

program
  .command("logs [sessionId]")
  .description("Inspect a discover session's log — status, errors, and the ledger path")
  .option("--list", "List all discover sessions for this repo")
  .option("--raw", "Print the raw JSONL ledger (useful for `synapse logs --raw | jq`)")
  .action(async (sessionId: string | undefined, opts: { list?: boolean; raw?: boolean }) => {
    const { runLogs } = await import("./commands/logs.js");
    await runLogs({
      sessionId,
      list: opts.list ?? false,
      raw: opts.raw ?? false,
    });
  });

program
  .command("update")
  .description("Update Synapse CLI to the latest version")
  .action(async () => {
    const { runUpdate } = await import("./commands/update.js");
    await runUpdate();
  });

program
  .command("uninstall")
  .description("Uninstall Synapse CLI and remove global config")
  .action(async () => {
    const { runUninstall } = await import("./commands/uninstall.js");
    await runUninstall();
  });

// Background version check (non-blocking)
import { checkForUpdate } from "./utils/version-check.js";
checkForUpdate(pkg.version);

program.parse();
