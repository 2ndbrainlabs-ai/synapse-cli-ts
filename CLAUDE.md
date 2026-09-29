# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@2ndbrainlabs-ai/synapse-cli` (the `synapse` binary): a Node 18+ ESM TypeScript CLI that reads a codebase and generates a runnable MCP server (Python/FastMCP today). Code exploration always runs client-side. Codegen runs either on the hosted Synapse backend over gRPC (the default) or in-process on the user's own LLM with `--local`.

## Commands

```bash
npm install                       # CI uses: npm ci --legacy-peer-deps
npm run dev -- <command> [flags]  # run CLI from source via tsx (e.g. npm run dev -- build --local)
npm run build                     # tsup → dist/
npm run lint                      # eslint src/ tests/
npm run typecheck                 # src only
npm run typecheck:tests           # src + tests (tsconfig.test.json)
npm test                          # vitest run (all tests)
npm run ci                        # lint + both typechecks + tests + build — run before pushing

npx vitest run tests/unit/providers/openai-compat.test.ts   # single file
npx vitest run -t "some test name"                          # single test by name
```

- `tsconfig.json` excludes `tests/`, so `npm run typecheck` does **not** check tests. Esbuild strips test types without checking them, so a test calling a renamed option can pass while asserting nothing. Run `typecheck:tests` after changing any signature that tests use.
- There is no vitest config file, so vitest uses its defaults. Tests import source with `.js` extensions (`../../src/backend/index.js`), as Node16 module resolution requires.
- `--dev` or `SYNAPSE_DEV=1` points the CLI at a local backend on `localhost:50051` (the sibling repo `../synapse-cli-backend`).
- `docs/LOCAL_MODE_VERIFICATION.md` is the manual pre-release checklist for `--local`.

## Architecture

### Entry and build
`src/index.ts` defines every command with commander and lazy-imports each handler (`await import("./commands/...")`). The global `--yes` flag, or a non-TTY stdout, sets `SYNAPSE_NON_INTERACTIVE=1`, and the prompt helpers read that variable instead of taking a flag. `tsup.config.ts` has **two entries**: the CLI (with a shebang) and `src/extractors/core/parse-worker.ts` → `dist/parse-worker.js` (a `worker_threads` module with no shebang). All bare imports stay external.

### Two build engines
- **v2 (the default)**: `src/commands/v2/build-v2.ts`. It runs deterministic surface extraction, then either the **Auto** track (exposes HTTP endpoints; `auto-flow.ts` for hosted, `local-auto-flow.ts` for local, which needs no LLM) or the **Custom** track (`custom-flow.ts`: composes internal functions into one MCP tool file written to the project root, and merges env vars into `.env.example`).
- **v1 (legacy)**: `--engine v1` → `src/commands/build.ts`. This is the older agent loop, where the backend drives the CLI's file tools (`src/tools/*`) over a bidirectional gRPC stream. It depends on `synapse analyze` / `src/builder/*`. Leave it as it is for backwards compatibility.

### Hosted vs local: one client interface
`src/grpc/client-factory.ts` defines `ISynapseClient` and returns one of two clients:
- `SynapseClient` (`src/grpc/client.ts`): gRPC to `grpc.synaps3.ai`, using `protos/synapse.proto`. The proto is loaded at runtime from either `../protos` or `../../protos`, so it ships in the npm package.
- `LocalSynapseClient` (`src/backend/index.ts`): an in-process port of the private Python backend. The pipeline is classify (`candidate-classifier.ts`) → shape (`tool-shaper.ts`) → render (`server-renderer.ts`) → smoke-verify/repair (`smoke-verifier.ts`). CONTRIBUTING says most work on prompts, schemas, templates and the verifier happens in `src/backend/`.

Both clients must keep matching public method shapes. `--local` applies to **one invocation only**; `resolveEffectiveMode` reads the flag and nothing else, and no config may persist `"mode": "local"`.

### LLM providers (local mode only)
- `src/config/llm-config.ts` → `resolveLlm()` resolves provider, models, endpoint and key. Precedence: CLI flags → `SYNAPSE_LLM_*` env → project `.synapse/config.json` `llm` block → global `~/.synapse/config.json` → Anthropic defaults. The `llm` block is strict-validated with zod; an invalid block produces a warning and falls through to the next source. Stored models and caps apply only to the provider they were saved for.
- `src/providers/catalog.ts`: per-provider specs (base URL, key env vars, default model per `Task`, and `ProviderCaps`: `toolChoice`, `maxTokensField`, `temperature`). Model ids are defaults only and are **never validated** client-side. This is deliberate.
- `src/providers/index.ts` → `createProvider()` builds either `AnthropicProvider` (official SDK, prompt caching) or `OpenAICompatProvider`, which serves every other provider. `providers/index.ts` avoids importing `ResolvedLlm` because that would create an import cycle between config and providers.
- **Every LLM call in the pipeline is one forced tool call that returns schema-shaped JSON** (`LlmProvider` in `providers/types.ts`). If a provider lacks `tool_choice`, its adapter emulates it with JSON mode plus the schema inlined in the prompt. Keep capability handling inside the adapters and out of callers.
- `src/backend/llm-call.ts`: retry, backoff and jitter; switches to `fallback_generate` after repeated overloads; sends one metadata-only trace per call (`trace-forwarder.ts`; `SYNAPSE_TELEMETRY=0` disables it). Callers pass a `Task`, never a model id.
- Inference keys are never written to disk unless the user passes `--save-key`, which stores them Fernet-encrypted and bound to the machine (`src/config/api-key-store.ts`).

### Surface extraction (`src/extractors/`)
- `core/extractor.ts` detects the repo's primary language from root markers and extension counts, then dispatches to `languages/<lang>-streamed.ts` / `<lang>-parse.ts`, which use tree-sitter for Python, TS, Java, C#, Go and Rust. The output is a `SurfaceManifest` (`core/surface-manifest.ts`) of HTTP endpoints plus ranked functions.
- `core/prefilter.ts` walks the repo, reads the first 64 KB of each file, and runs an Aho-Corasick needle sniff (`core/needles.ts`) so only candidate files get parsed. `core/parse-pool.ts` spreads parsing across worker threads and parses inline if workers fail to start.
- **`core/manifest-wire.ts` is a wire contract with the Python backend.** Required fields are defined in `protos/wire-manifest.schema.json` and enforced by `tests/unit/extractors/manifest-wire.contract.test.ts`. If you change a required field, update the schema, the serializer, and the backend Pydantic model (`synapse-cli-backend/.../surface_manifest.py`) together.

### Sessions
`src/session/`: v2 builds write an append-only JSONL ledger under `.synapse/`. `SessionManager` owns the `AbortController`. Ctrl-C and `--max-time` append `session_paused` and exit 0, and `--resume` replays the ledger's SHA cache so only changed files are parsed again. `synapse logs` reads these ledgers.

### Config and paths
`src/config/paths.ts` defines the project dir `.synapse/` and the global dir `~/.synapse/`. For the hosted service, config resolves env (`SYNAPSE_API_KEY`, `SYNAPSE_BACKEND_URL`, `SYNAPSE_DEV`) → project → global (`config/manager.ts`). Root `config.json` ships with the package and holds backend URLs.

## Conventions (from CONTRIBUTING)

- TypeScript strict; no `any` or `@ts-ignore` in new code (ESLint only warns on `any`). Prefix unused vars/args with `_`.
- No `console.log` in shipped code. Use the helpers in `src/ui/theme.ts` (`t`, `stepInfo`, `stepWarn`, `sectionHeader`) and `src/ui/box.ts` (`roundedBox`) so TTY and non-TTY output match.
- Don't add runtime dependencies without discussion; install size matters.
- Every bug fix comes with a test that fails without the fix. Branch from `main`.
- `test-apis.ts` at the repo root is an ad-hoc script that reads `/tmp` fixtures. It is not part of the test suite; the real fixtures are in `tests/fixtures/multi-lang-apis/`.
