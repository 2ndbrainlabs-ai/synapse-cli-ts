# Architecture

How the CLI is put together. Terms are defined in [CONTEXT.md](../CONTEXT.md); what users see is in the [README](../README.md).

## Entry and build

- `src/index.ts` defines every command with commander and lazy-imports each handler (`await import("./commands/...")`), so `synapse --help` doesn't load tree-sitter or gRPC.
- It calls `dotenv` at startup, so a `.env` in the **current directory** (the user's project) is loaded into `process.env`.
- The global `--yes` flag, or a non-TTY stdout, sets `SYNAPSE_NON_INTERACTIVE=1`. Prompt helpers in `src/ui/prompt.ts` read that variable instead of taking a flag.
- `--dev` / `SYNAPSE_DEV=1` points the CLI at a backend on `localhost:50051` (maintainers only; the backend isn't open source).
- `tsup.config.ts` has **two entries**: the CLI (`dist/index.js`, with a shebang) and `src/extractors/core/parse-worker.ts` → `dist/parse-worker.js` (a `worker_threads` module, no shebang). All bare imports stay external.

## Commands

| Command | Module |
| --- | --- |
| `init` | `src/commands/init.ts` |
| `build` (v2) | `src/commands/v2/build-v2.ts` |
| `analyze` | `src/commands/analyze.ts` (Python scan for `info` stats and indexed-lines reporting) |
| `config`, `config set-key / keys / revoke` | `src/commands/config.ts` |
| `model`, `model list / set / reset` | `src/commands/model.ts` |
| `info`, `logs`, `update`, `uninstall` | `src/commands/<name>.ts` |

## Build engines

- **v2 (the only engine):** `src/commands/v2/build-v2.ts`. Runs surface extraction, then one of two tracks:
  - **Auto** (`auto-flow.ts` hosted, `local-auto-flow.ts` for `--local`, which needs no model unless `--smart-names` is set): exposes the project's HTTP endpoints as tools.
  - **Custom** (`custom-flow.ts`): composes internal functions into one tool file written to the project root, and merges the env vars it needs into `.env.example`.
  - `mode-picker.ts` and `endpoint-picker.ts` handle the interactive choices; `build-outcome.ts` maps results to exit codes.
- **v1 (removed, SYN-257):** the legacy agent-loop engine is gone. `--engine v1` and its v1-only flags (`-o`, `-g`, `--no-validate`, `--no-docs`) are hidden and print a removal message (`src/commands/removed.ts`). `synapse analyze` stays.

## Hosted vs local: one client interface

`src/grpc/client-factory.ts` defines `ISynapseClient` and returns one of two implementations:

- **`SynapseClient`** (`src/grpc/client.ts`): gRPC to the hosted backend using `protos/synapse.proto`. The proto is loaded at runtime from `../protos` or `../../protos`, which is why `protos/` ships in the package.
- **`LocalSynapseClient`** (`src/backend/index.ts`): an in-process pipeline: classify (`candidate-classifier.ts`) → shape (`tool-shaper.ts`) → render (`server-renderer.ts`) → smoke-verify and repair (`smoke-verifier.ts`). Prompts are in `prompts.ts`, zod schemas in `schemas.ts`. Most work on prompts, schemas, templates and the verifier happens here.

Both must keep matching public method shapes. `--local` applies to one invocation only: `resolveEffectiveMode` (`src/config/manager.ts`) reads the flag and nothing else.

## LLM providers (`--local` only)

- `src/config/llm-config.ts` → `resolveLlm()` resolves provider, models, endpoint and key. Precedence: CLI flags → `SYNAPSE_LLM_*` env → project `.synapse/config.json` `llm` block → global `~/.synapse/config.json` → Anthropic defaults. The `llm` block is validated with zod; an invalid block warns and falls through. Stored models and caps apply only to the provider they were saved for.
- `src/providers/catalog.ts`: one `ProviderSpec` per provider: kind, base URL, key env vars, default model per `Task`, `ProviderCaps`, extra headers. **Model ids are defaults only and are never validated client-side**, on purpose.
- `src/providers/index.ts` → `createProvider()` builds `AnthropicProvider` (official SDK, prompt caching), `BedrockProvider`, `VertexProvider`, or `OpenAICompatProvider` for everything else. It takes a structural `ProviderInit` instead of importing `ResolvedLlm`, to avoid an import cycle with `config/`.
- **Every pipeline LLM call is one forced tool call returning schema-shaped JSON** (`LlmProvider` in `providers/types.ts`). If a provider lacks `tool_choice`, its adapter emulates it with JSON mode and the schema inlined in the prompt. Capability handling stays inside adapters, never in callers.
- `src/backend/llm-call.ts`: retry with backoff and jitter, switch to `fallback_generate` after repeated overloads, and one metadata-only trace per call (`trace-forwarder.ts`). Callers pass a `Task`, never a model id.

## Surface extraction (`src/extractors/`)

- `core/extractor.ts` detects the primary language from root markers and extension counts, then dispatches to `languages/<lang>-streamed.ts` / `<lang>-parse.ts` (tree-sitter for Python, TypeScript, Java, C#, Go, Rust). Output: a `SurfaceManifest` of HTTP endpoints and ranked functions.
- `core/prefilter.ts` walks the repo, reads the first 64 KB of each file, and runs an Aho-Corasick needle sniff (`core/needles.ts`) so only candidate files are parsed. `core/parse-pool.ts` spreads parsing over worker threads and falls back to inline parsing if workers fail to start.
- **`core/manifest-wire.ts` is a wire contract with the backend.** Required fields are defined in `protos/wire-manifest.schema.json` and enforced by `tests/unit/extractors/manifest-wire.contract.test.ts`.

## Sessions

`src/session/`: v2 builds write an append-only JSONL ledger under `.synapse/`. `SessionManager` owns the `AbortController`. Ctrl-C and `--max-time` append `session_paused` and exit 0; `--resume` replays the ledger so only changed files are parsed again. `synapse logs` reads these ledgers.

## Config, keys and paths

- `src/config/paths.ts`: project dir `.synapse/`, global dir `~/.synapse/`.
- Hosted config resolves env (`SYNAPSE_API_KEY`, `SYNAPSE_BACKEND_URL`, `SYNAPSE_API_URL`, `SYNAPSE_DEV`) → project → global (`src/config/manager.ts`). The root `config.json` ships with the package and holds the public default endpoints and version.
- `src/config/api-key-store.ts`: Fernet encryption for saved keys. See [security.md](security.md).

## Telemetry and privacy

- `src/grpc/telemetry.ts`: analytics events and REST quota calls. `SYNAPSE_TELEMETRY=0` turns analytics off; quota checks still run for hosted builds because the free tier is enforced from them.
- `src/backend/trace-forwarder.ts`: one metadata-only trace per `--local` LLM call (no prompts or code; a hash of the prompt). Also honours `SYNAPSE_TELEMETRY=0`.
- `src/utils/telemetry-hash.ts`: keyed hashes of paths and machine ids, with a random salt kept in `~/.synapse/telemetry-salt` and never sent.
- The README table "What leaves your machine" is the user-facing contract. Keep it true.

## Terminal UI

`src/ui/`: `theme.ts` (colours, `t`, step helpers), `box.ts`, `prompt.ts` (all prompts, honours non-interactive mode), `spinner.ts`, `errors.ts` (error classification and friendly messages). Commands print through these so TTY and non-TTY output stay consistent.
