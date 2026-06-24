import { config as loadDotenv } from "dotenv";
loadDotenv();

import { createRequire } from "node:module";
import { Command } from "commander";

// Suppress gRPC logging before any grpc imports
process.env.GRPC_VERBOSITY = "ERROR";
process.env.GRPC_TRACE = "";
process.env.GRPC_ENABLE_FORK_SUPPORT = "0";

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
  .option("-q, --query <query>", "MCP server requirements")
  .option("-o, --output <file>", "Output file for generated server", "mcp_server.py")
  .option("--no-validate", "Skip validation step")
  .option("--no-docs", "Skip documentation step")
  .option("-g, --generate", "Skip planner and use existing todo_list.md")
  .action(async (opts) => {
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
