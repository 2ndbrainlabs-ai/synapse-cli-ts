import { config as loadDotenv } from "dotenv";
loadDotenv();

import { createRequire } from "node:module";
import { Command, Option } from "commander";

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
  .option("--dev", "Use local backend (localhost:50051)")
  .option(
    "-y, --yes",
    "Skip every interactive prompt (use defaults / first choice). Sets SYNAPSE_NON_INTERACTIVE=1 for the rest of the process.",
  )
  .hook("preAction", (thisCommand) => {
    // Propagate --yes as an env var so any nested import can see it without
    // threading a flag through every function signature. Also set implicitly
    // when the CLI isn't attached to a TTY (piped output, CI).
    const opts = thisCommand.opts();
    if (opts.yes || !process.stdout.isTTY) {
      process.env.SYNAPSE_NON_INTERACTIVE = "1";
    }
  });

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
    await runInit({
      force: opts.force ?? false,
    });
  });

// Removed with the v1 engine (SYN-257). Hidden; explains the removal and
// exits non-zero instead of commander's "unknown command".
program
  .command("analyze", { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    const { runAnalyzeRemoved } = await import("./commands/removed.js");
    runAnalyzeRemoved();
  });

function collectHeader(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command("build")
  .description("Build MCP server based on requirements")
  .option("-q, --query <query>", "v2 custom: workflow intent")
  // Hidden: v2 is the only engine (SYN-257). `--engine v2` is accepted as a
  // no-op; `--engine v1` explains that v1 was removed.
  .addOption(new Option("--engine <version>", "Build engine (only v2)").hideHelp())
  // Hidden v1-only options: explain the removal instead of "unknown option".
  .addOption(new Option("-o, --output <file>").hideHelp())
  .addOption(new Option("-g, --generate").hideHelp())
  .addOption(new Option("--no-validate").hideHelp())
  .addOption(new Option("--no-docs").hideHelp())
  .option("--auto", "v2: force Auto track (expose HTTP endpoints via runner)")
  .option("--custom", "v2: force Custom track (compose internal functions)")
  .option("--base-url <url>", "v2 auto: deployed base URL for the API")
  .option(
    "--server-name <name>",
    "v2 auto: MCP server name (default: folder name). Rebuilds update the server with this name; " +
      "a different name gives the repo a second server",
  )
  .option(
    "--new",
    "v2 auto: create a new MCP server instead of updating this repo's existing one (new server id)",
  )
  .option(
    "--all-endpoints",
    "v2 auto: expose every detected endpoint without the picker (implies --auto; for CI / no TTY)",
  )
  .option(
    "--endpoints <list>",
    'v2 auto: comma-separated endpoints to expose without the picker — "GET /path", "/path" ' +
      "or tool names (implies --auto; for CI / no TTY)",
  )
  .option(
    "--smart-names",
    "v2 auto: read handler source (+ README/docs) to name/describe tools from real " +
      "behavior instead of route + docstring alone. Local runs it on your configured " +
      "provider; hosted runs it server-side.",
  )
  .option("--resume", "v2: resume the most recent unfinished discover session for this repo")
  .option("--max-time <minutes>", "v2: soft wall-clock cap in minutes (default 15)")
  .option("--deep", "v2 custom: raise candidate cap from 200 to 500 during classification")
  .option(
    "--local",
    "One-shot override: run this build locally on your own model. " +
      "Uses the provider from `synapse model`. Doesn't change the project's stored mode.",
  )
  // One-shot provider overrides for --local. Persist them with `synapse model set`.
  .option(
    "--provider <name>",
    "--local: provider for this build — anthropic | openai | groq | grok | openrouter | ollama | custom | bedrock | vertex",
  )
  .option("--model <id>", "--local: model id for this build (pins every stage)")
  .option("--llm-base-url <url>", "--local: OpenAI-compatible endpoint for this build")
  .option("--llm-api-key <key>", "--local: inference API key for this build")
  .option("--llm-region <region>", "--local: AWS region (bedrock) or Vertex location for this build")
  .option("--llm-project <id>", "--local: GCP project for vertex for this build")
  .option(
    "--anthropic-key <key>",
    "Deprecated alias for --llm-api-key; implies --provider anthropic.",
  )
  .action(async (opts) => {
    const { checkRemovedBuildOptions } = await import("./commands/removed.js");
    if (checkRemovedBuildOptions(opts)) {
      const { runBuildV2 } = await import("./commands/v2/build-v2.js");
      const maxTimeMinutes = opts.maxTime ? Number(opts.maxTime) : undefined;
      await runBuildV2({
        auto: opts.auto ?? false,
        custom: opts.custom ?? false,
        query: opts.query,
        baseUrl: opts.baseUrl,
        serverName: opts.serverName,
        newServer: opts.new ?? false,
        allEndpoints: opts.allEndpoints ?? false,
        endpoints: opts.endpoints,
        smartNames: opts.smartNames ?? false,
        resume: opts.resume ?? false,
        maxTimeMinutes: Number.isFinite(maxTimeMinutes) ? (maxTimeMinutes as number) : undefined,
        deep: opts.deep ?? false,
        local: opts.local ?? false,
        provider: opts.provider,
        model: opts.model,
        llmBaseUrl: opts.llmBaseUrl,
        llmApiKey: opts.llmApiKey,
        llmRegion: opts.llmRegion,
        llmProject: opts.llmProject,
        anthropicKey: opts.anthropicKey,
      });
    }
  });

// `synapse model` — provider selection for local builds. Bare invocation shows
// the resolved config; subcommands list, switch and clear it.
const modelCmd = program
  .command("model")
  .description(
    "Show or switch the inference provider used by local builds (`synapse build --local`)",
  )
  .action(async () => {
    const { runModelShow } = await import("./commands/model.js");
    runModelShow();
  });

modelCmd
  .command("list")
  .description("List supported inference providers and their default models")
  .action(async () => {
    const { runModelList } = await import("./commands/model.js");
    runModelList();
  });

modelCmd
  .command("set <provider>")
  .description(
    "Switch provider: anthropic | openai | groq | grok | openrouter | ollama | custom | bedrock | vertex",
  )
  .option("--model <id>", "Model id for every pipeline stage")
  .option("--triage <id>", "Model for candidate classification (cheap, high volume)")
  .option("--generate <id>", "Model for code generation")
  .option("--verify <id>", "Model for verification and repair")
  .option("--fallback <id>", "Model used when the primary is overloaded")
  .option("--base-url <url>", "OpenAI-compatible endpoint (required for `custom`)")
  .option(
    "--save-key <key>",
    "Persist the API key, encrypted and bound to this machine. " +
      "Off by default — keys are normally read from the environment each run.",
  )
  .option("--header <name:value>", "Extra request header (repeatable)", collectHeader, [])
  .option("--no-tool-choice", "Endpoint ignores tool_choice — coerce JSON output instead")
  .option("--max-completion-tokens", "Endpoint expects max_completion_tokens, not max_tokens")
  .option("--no-temperature", "Endpoint rejects the temperature parameter")
  .option("--region <region>", "bedrock: AWS region · vertex: location (e.g. global, us-east5)")
  .option("--project <id>", "vertex: GCP project id")
  .option("--profile <name>", "bedrock: AWS profile from ~/.aws/config")
  .option("--global", "Save to ~/.synapse instead of this project")
  .action(async (provider: string, opts) => {
    const { runModelSet } = await import("./commands/model.js");
    runModelSet(provider, {
      model: opts.model,
      triage: opts.triage,
      generate: opts.generate,
      verify: opts.verify,
      fallback: opts.fallback,
      baseUrl: opts.baseUrl,
      saveKey: opts.saveKey,
      header: opts.header,
      // commander maps --no-x to x:false, so invert back to our opt-in flags.
      noToolChoice: opts.toolChoice === false,
      maxCompletionTokens: opts.maxCompletionTokens ?? false,
      noTemperature: opts.temperature === false,
      region: opts.region,
      project: opts.project,
      profile: opts.profile,
      globalScope: opts.global ?? false,
    });
  });

modelCmd
  .command("reset")
  .description("Remove the saved inference config (local builds return to Anthropic)")
  .option("--global", "Clear ~/.synapse instead of this project")
  .action(async (opts) => {
    const { runModelReset } = await import("./commands/model.js");
    runModelReset({ globalScope: opts.global ?? false });
  });

// `synapse config` — bare invocation shows settings (keys redacted);
// subcommands change the API key and manage the account's keys.
const configCmd = program
  .command("config")
  .description("Show settings, or change and revoke Synapse API keys")
  .option("--key <apiKey>", "Same as `synapse config set-key <apiKey>`")
  .option("--update", "Same as `synapse config set-key` (prompts for the key)")
  .option("--global", "With --key/--update: save to ~/.synapse only")
  .action(async (opts) => {
    const cfg = await import("./commands/config.js");
    if (opts.key !== undefined || opts.update) {
      await cfg.runConfigSetKey({ key: opts.key, globalScope: opts.global ?? false });
    } else {
      cfg.runConfigShow();
    }
  });

configCmd
  .command("set-key [apiKey]")
  .description(
    "Verify a Synapse API key and save it (prompts when omitted, which keeps it out of shell history)",
  )
  .option("--global", "Save to ~/.synapse only, leaving this project's saved key alone")
  .action(async (apiKey: string | undefined, opts, cmd) => {
    const { runConfigSetKey } = await import("./commands/config.js");
    // --global may be parsed by the parent `config` command.
    const all = cmd.optsWithGlobals();
    await runConfigSetKey({ key: apiKey, globalScope: Boolean(opts.global ?? all.global) });
  });

configCmd
  .command("keys")
  .description("List the active API keys on your Synapse account")
  .action(async () => {
    const { runConfigKeys } = await import("./commands/config.js");
    await runConfigKeys();
  });

configCmd
  .command("revoke <keyId>")
  .description("Revoke an API key on your account (ids from `synapse config keys`)")
  .option("-y, --yes", "Don't ask for confirmation")
  .action(async (keyId: string, opts, cmd) => {
    const { runConfigRevoke } = await import("./commands/config.js");
    // The program-level -y/--yes usually claims the flag; on revoke it is
    // the confirmation.
    const yes = Boolean(opts.yes ?? cmd.optsWithGlobals().yes);
    await runConfigRevoke(keyId, { yes });
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
