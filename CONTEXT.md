# CONTEXT.md: Synapse CLI glossary

The words this repo uses for its domain. Use these terms in code, tests, issues and PRs. If you need a concept that isn't here, either you're inventing language the project doesn't use, or there's a gap worth adding in the same PR.

## Product

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Synapse** | The product: turns a codebase into an MCP server an AI agent can call. | |
| **CLI** | This repo: the `synapse` binary, published as `@2ndbrainlabs-ai/synapse-cli`. | |
| **MCP server** | What a build produces: a set of MCP tools, either served by the hosted runner (hosted Auto) or written to the user's project as a Python file. | app, project |
| **Tool** | One MCP tool in a generated server. | function (that's source code) |
| **Console** | The Synapse web app where users create API keys and see their servers. Not in this repo. | dashboard |
| **Backend** | The hosted Synapse service the CLI talks to over gRPC (builds) and REST (quota, telemetry, keys). Not in this repo. | server (ambiguous with MCP server) |

## Builds

| Term | Meaning |
| --- | --- |
| **v2 engine** | The default build engine (`src/commands/v2/`): local surface extraction, then the Auto or Custom track. |
| **v1 engine** | The legacy agent-loop engine (`--engine v1`, with `synapse analyze`). Kept for backwards compatibility only; don't build on it. |
| **Auto track** / **Auto mode** | Exposes the project's existing HTTP endpoints as tools. Hosted: saved to the user's account and served by the runner. `--local`: a passthrough server file, no model call needed. |
| **Custom track** / **Custom mode** | Composes internal functions into one tool from a workflow description (`-q`), written to the project root as a Python file. |
| **Hosted mode** | A build that uses the Synapse backend. Needs a Synapse API key and counts against quota. The default. |
| **Local mode** | A build with `--local`: codegen runs in-process (`src/backend/`) on the user's own model. Per invocation only, never persisted. |
| **Smart names** | `--smart-names`: a model names and describes Auto-mode tools from handler source and docs. |

## Extraction

| Term | Meaning |
| --- | --- |
| **Surface extraction** | Deterministic tree-sitter scan of the repo for HTTP endpoints and ranked functions (`src/extractors/`). Always runs on the user's machine. |
| **Surface manifest** | The output of surface extraction (`SurfaceManifest`, `core/surface-manifest.ts`). |
| **Wire manifest** | The serialized manifest sent to the backend (`core/manifest-wire.ts`), defined by `protos/wire-manifest.schema.json`. A contract. |
| **Prefilter** / **needle sniff** | Reading the first 64 KB of each file and matching framework markers (Aho-Corasick) so only candidate files get parsed. |
| **Endpoint** | One HTTP route found in the user's code (method + path + handler). Becomes one tool in Auto mode. |

## Local codegen pipeline

| Term | Meaning |
| --- | --- |
| **Provider** | An LLM backend for `--local` (`anthropic`, `openai`, `groq`, `grok`, `openrouter`, `ollama`, `custom`, `bedrock`, `vertex`). Specs in `src/providers/catalog.ts`. |
| **Task** | A pipeline stage that maps to a model: `triage`, `generate`, `verify`, `fallback_generate`. Callers pass a task, never a model id. |
| **Caps** | Per-provider capability flags (`toolChoice`, `maxTokensField`, `temperature`, `promptCache`) that adapters use to handle API differences. |
| **Forced tool call** | Every pipeline LLM call is one tool call returning schema-shaped JSON. Providers without `tool_choice` get JSON mode plus the inlined schema. |
| **Classify → shape → render → verify** | The pipeline stages: `candidate-classifier.ts`, `tool-shaper.ts`, `server-renderer.ts`, `smoke-verifier.ts`. |

## Accounts, config and telemetry

| Term | Meaning |
| --- | --- |
| **Synapse API key** | The user's credential for the hosted service (`SYNAPSE_API_KEY` or saved with `synapse config set-key`). |
| **Inference key** | The user's own model-provider key for `--local`. Read from env or a flag; written to disk only with `--save-key`. |
| **Project config** / **global config** | `.synapse/config.json` in the project / `~/.synapse/config.json`. Env overrides project overrides global. |
| **Session** / **ledger** | One build run, recorded as an append-only JSONL ledger under `.synapse/`. Powers `--resume` and `synapse logs`. |
| **Quota** | Hosted free-tier limits (MCP servers, indexed lines). Enforced by the backend; checks run even with telemetry off. |
| **Telemetry** | Metadata-only usage events and per-call traces. No code, no prompts. Disabled with `SYNAPSE_TELEMETRY=0`. |
