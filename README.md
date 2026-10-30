<div align="center">

<img src="https://unpkg.com/@2ndbrainlabs-ai/synapse-cli/docs/logo.png" alt="Synapse" width="360" />

### Enterprise Context Engine

**Today: MCP Servers. Tomorrow: Every Context Surface Your Stack Needs.**

Turn any codebase into a production-ready [Model Context Protocol](https://modelcontextprotocol.io) server — from your terminal, in seconds.

[Homepage](https://synapse.2ndbrainlabs.ai) · [Docs](https://synapse.2ndbrainlabs.ai/docs) · [Report an issue](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues) · [Discussions](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/discussions)

[![npm version](https://img.shields.io/npm/v/@2ndbrainlabs-ai/synapse-cli.svg?logo=npm&color=D97757)](https://www.npmjs.com/package/@2ndbrainlabs-ai/synapse-cli)
[![node](https://img.shields.io/node/v/@2ndbrainlabs-ai/synapse-cli.svg?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/License-Apache_2.0-green.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![downloads](https://img.shields.io/npm/dm/@2ndbrainlabs-ai/synapse-cli.svg?color=blue)](https://www.npmjs.com/package/@2ndbrainlabs-ai/synapse-cli)

</div>

---

## What is Synapse?

Synapse is building the context layer enterprises need to make their internal systems agent-ready. Today, we're open-sourcing the first piece of that vision: an agentic MCP server generator that analyzes existing codebases and generates production-ready MCP servers.

Synapse is a CLI that reads your codebase and generates a runnable MCP server — the tool schemas, argument marshalling, and boilerplate are all handled for you. Point it at a project, describe what you want exposed, and drop the resulting server into Claude Desktop, Cursor, or any MCP-compatible client.

The CLI scans your code **client-side**: language detection and route/function extraction run on your machine with tree-sitter. Generation runs on the Synapse backend by default, so model routing, retries, and quota stay centrally managed — or entirely on your own model with `--local`, using Anthropic, OpenAI, Groq, xAI, OpenRouter, Ollama, Amazon Bedrock, Google Vertex AI, or your own inference endpoint. Some of what the scan finds (routes, function signatures, docstrings and, with `--smart-names`, handler source) is sent to the backend or to your model to do the generation. See [What leaves your machine](#what-leaves-your-machine) and [Run locally with your own model](#run-locally-with-your-own-model).

## Install

```bash
npm install -g @2ndbrainlabs-ai/synapse-cli
```

Requires **Node.js 20+**. Verify with `synapse --version`.

## Quick start

> Before running `synapse init`, generate your Synapse API key by following the [docs](https://synapse.2ndbrainlabs.ai/docs#configuration).

```bash
cd my-project
synapse init                    # one-time: paste your API key
synapse build                   # scans the code, then asks: Auto or Custom?
```

`synapse build` asks how you want to build (skip the prompt with `--auto` or `--custom`). Copy the printed JSON snippet into your MCP client config and you're done.

Prefer to describe the tool yourself (Custom mode):

```bash
synapse build --custom --query "Expose user auth and profile lookup as one MCP tool"
```

The free tier includes **10 MCP servers and 100,000 indexed lines**. `synapse info` shows your current usage.

Indexed lines are the lines of the source files a hosted build scans (`synapse analyze` counts every Python file). Each run reports only the lines added since the last accepted report, so rebuilding an unchanged repo costs nothing. Local builds (`--local`) are never counted.

## Build modes: Auto and Custom

`synapse build` runs the **v2 engine** by default. It detects your project's language, extracts its surface locally, and then builds in one of two modes:

| | **Auto** (`--auto`) | **Custom** (`--custom`) |
|---|---|---|
| What it does | Finds your HTTP routes and exposes the ones you pick as MCP tools that call your deployed API | Composes internal functions you pick (or describe with `--query`) into one MCP tool |
| Languages it reads | 6: Python, TypeScript (`.ts`, `.tsx`), Java, C#, Go, Rust | Python only, today |
| Hosted output | No file is written. The endpoint config is saved to your Synapse account and served by the `@2ndbrainlabs-ai/synapse-mcp` runner (`npx`) | A Python file, `<tool_name>_server.py`, in the project root |
| `--local` output | A Python file, `synapse_auto_server.py`. Python projects only; for other languages `--local --smart-names` names the tools but writes no file | A Python file, `<tool_name>_server.py`. Python projects only |

**Every generated server file is Python.** The CLI does not generate TypeScript or JavaScript servers. Plain JavaScript files (`.js`, `.jsx`) are not scanned. If the project root has a marker file (`pyproject.toml`, `requirements.txt`, `tsconfig.json`, `pom.xml`, `go.mod`, `Cargo.toml`, …) it decides the language; otherwise the most common source extension wins.

Without a flag, the picker defaults to Auto. `--smart-names` (Auto only) reads each selected handler's source plus your README to give the tools better names and descriptions.

### Rebuilding

A hosted Auto build creates one MCP server for the project and records its id in `.synapse/config.json`. Later builds update that same server: new endpoints are added, changed ones updated, and ones no longer in the code removed. The server id, and so the `SYNAPSE_SERVER_ID` in your MCP client config, stays the same, and a rebuild doesn't use up another MCP server from your quota.

- If the server was deleted (or the API key belongs to a different account), the build creates a new one and tells you to update `SYNAPSE_SERVER_ID`.
- `--new` creates a new server instead of updating the existing one, and later builds update the new one.
- `--server-name <name>` picks the server by name (default: the folder name), so a different name gives the project a second server.

### Scripts and CI

Auto mode asks which endpoints to expose. Where there's no terminal (CI, pipes, `--yes`), select them with a flag instead; either flag implies `--auto`:

```bash
synapse build --auto --all-endpoints                                  # every detected endpoint
synapse build --auto --endpoints "GET /patients,POST /patients"       # by method and path
synapse build --auto --endpoints "/patients,get_patient_by_id"        # by path or tool name
```

Without a terminal and without either flag, the build stops with an error instead of exposing nothing.

`synapse build` exits non-zero whenever the build doesn't finish: a failed composition, no endpoints selected, an invalid API key, an unreachable backend, a server error, or a scan paused by `--max-time` or Ctrl-C (resume with `--resume`).

The legacy **v1 engine** is still available with `--engine v1`. It needs `synapse analyze` first, analyzes Python only, runs only on the hosted service, and writes `./mcp_server.py` (change with `-o`).

## Run locally with your own model

Skip the hosted Synapse service entirely — codegen runs in-process using **your** inference provider. No quota and no signup required. Your code never goes to Synapse; the parts the model needs go to the provider you choose (see [What leaves your machine](#what-leaves-your-machine)).

```bash
export ANTHROPIC_API_KEY=sk-ant-…

cd my-project
synapse build --local           # generates locally on your own key
```

`--local` is a **per-invocation** flag — no project config pins a repo to local mode, so switching back is just dropping the flag. `synapse init` is not required for a local build.

Locally-generated servers don't count against any quota. Anonymous usage telemetry (no code, no prompts — event names, counts, token usage and hashed ids) still flows to `api.synapse.2ndbrainlabs.ai`; opt out with `SYNAPSE_TELEMETRY=0`.

**Local-mode limits:**
- Generated files are Python, and only Python projects get one. Auto mode on a TypeScript, Java, C#, Go or Rust project can name the tools (`--smart-names`) but writes no file; run it without `--local` to use the hosted runner instead.
- Both modes work locally. Auto (`--auto`) writes a passthrough server without calling a model (unless you add `--smart-names`); Custom (`--custom`) uses your model to compose the tool.
- The legacy v1 engine (`--engine v1`) is hosted-only.
- Provider selection applies to local mode **only** — hosted builds run on the Synapse service, and `synapse model` does not change them.

### Choosing a provider

Local mode is not Anthropic-only. `synapse model` picks the provider and models it runs on:

```bash
synapse model                   # what a local build would use right now
synapse model list              # every provider, its default model, key status
synapse model set groq          # switch (keeps that provider's defaults)
synapse model reset             # back to Anthropic
```

| Provider | `set` id | Endpoint | API style |
|---|---|---|---|
| Anthropic (default) | `anthropic` | Messages API | native |
| OpenAI | `openai` | `https://api.openai.com/v1` | chat completions |
| Groq | `groq` | `https://api.groq.com/openai/v1` | chat completions |
| xAI (Grok) | `grok` | `https://api.x.ai/v1` | chat completions |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | chat completions |
| Ollama | `ollama` | `http://localhost:11434/v1` | chat completions |
| Amazon Bedrock | `bedrock` | your AWS region | Converse API |
| Google Vertex AI | `vertex` | your GCP project + location | Anthropic API (Claude), chat completions (Gemini) |
| Your own endpoint | `custom` | you supply | chat completions |

Pin models per stage — the pipeline uses a cheap model for high-volume triage and a strong one for codegen, so you can mix:

```bash
synapse model set groq --generate "openai/gpt-oss-120b" --triage "llama-3.1-8b-instant"
synapse model set openai --model gpt-5        # one --model pins every stage
```

Model ids are **not validated** against a built-in list — provider catalogues change often (Groq retired the Kimi and Llama-4-Scout ids during 2026; xAI redirects whole `grok-3` / `grok-4-fast` families), so a hardcoded allowlist would reject valid models and need a CLI release to fix. Any id your provider accepts works. If an id is wrong, the provider says so.

## Providing your API key

Synapse does not sniff for keys. You choose the provider; the provider's spec declares which environment variable holds its key. There are three ways to supply one, checked in this order:

**1. Environment variable — the default, and the recommended path.**

| Provider | Env var(s), in order | Required? |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | yes |
| `openai` | `OPENAI_API_KEY` | yes |
| `groq` | `GROQ_API_KEY` | yes |
| `grok` | `XAI_API_KEY`, then `GROK_API_KEY` | yes |
| `openrouter` | `OPENROUTER_API_KEY` | yes |
| `ollama` | `OLLAMA_API_KEY` | **no** |
| `custom` | `SYNAPSE_LLM_API_KEY` | no |
| `bedrock` | none — your AWS credentials | see [Cloud providers](#cloud-providers-amazon-bedrock-and-google-vertex-ai) |
| `vertex` | none — Google Application Default Credentials | see [Cloud providers](#cloud-providers-amazon-bedrock-and-google-vertex-ai) |

Two conveniences:

- **xAI accepts either name** — both `XAI_API_KEY` and `GROK_API_KEY` are in circulation, so both are read (`XAI_API_KEY` wins).
- **`SYNAPSE_LLM_API_KEY` is a universal fallback** for *every* provider, tried after the provider-specific var. Useful in CI, where one secret can serve whichever provider is configured.

Ollama needs no key, and Synapse omits the `Authorization` header entirely when there isn't one — so a bare local Ollama works with no credentials at all.

**2. A flag, for a single run** — nothing is written anywhere:

```bash
synapse build --local --llm-api-key sk-… --provider openai
```

**3. Stored, encrypted — explicit opt-in** (see [Where keys are stored](#where-keys-are-stored)):

```bash
synapse model set groq --save-key gsk_…
```

### Copy-paste quickstarts

```bash
# Anthropic (default — nothing to configure)
export ANTHROPIC_API_KEY=sk-ant-…
synapse build --local

# Groq
export GROQ_API_KEY=gsk_…
synapse model set groq
synapse build --local

# OpenAI
export OPENAI_API_KEY=sk-…
synapse model set openai
synapse build --local

# xAI (Grok)
export XAI_API_KEY=xai-…
synapse model set grok
synapse build --local

# OpenRouter
export OPENROUTER_API_KEY=sk-or-…
synapse model set openrouter
synapse build --local

# Ollama — no key needed
ollama pull qwen3-coder:30b
synapse model set ollama
synapse build --local
```

### Cloud providers: Amazon Bedrock and Google Vertex AI

Run local codegen on models in **your own** AWS or Google Cloud account. Synapse never sees or stores a cloud credential: it uses the same credentials your `aws` / `gcloud` CLI already uses, and `--save-key` is refused for these providers.

**Amazon Bedrock** — credentials from the standard AWS chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, a profile (`AWS_PROFILE` or `--profile`), an SSO session from `aws sso login`, or a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`. Requires Node 20+.

```bash
aws sso login --profile work
synapse model set bedrock --region us-east-1 --profile work
synapse build --local
```

- Defaults are Claude Sonnet 4.5 (generate) and Haiku 4.5 (triage) via **cross-region inference profiles**. The `us.` / `eu.` / `apac.` prefix is picked from your region automatically.
- Enable access to the models in the Bedrock console (**Model access**) for that region first. Otherwise Bedrock returns an access-denied error, which Synapse explains.
- Any Bedrock model works through the Converse API, e.g. `--model us.amazon.nova-pro-v1:0`. Claude, Nova and Mistral get a forced tool call. Other families get a JSON fallback.
- Region comes from `--region`, then `SYNAPSE_LLM_REGION`, then the saved config, then `AWS_REGION` / `AWS_DEFAULT_REGION`, then `us-east-1`.

**Google Vertex AI** — credentials from Application Default Credentials: `gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account key, or the attached service account on GCP. The account needs `roles/aiplatform.user`.

```bash
gcloud auth application-default login
synapse model set vertex --project my-gcp-project            # Claude, global location
synapse model set vertex --project my-gcp-project --model gemini-2.5-pro
synapse build --local
```

- `claude-*` model ids go to Vertex's Anthropic API, so behaviour, forced tool calls and prompt caching match the direct Anthropic path. Enable the Claude models in **Model Garden** first.
- Any other id (`gemini-2.5-pro`, `gemini-2.5-flash`, Model Garden models) goes to Vertex's OpenAI-compatible endpoint. You can mix them per stage: `--triage gemini-2.5-flash --generate claude-sonnet-4-5@20250929`.
- Location defaults to `global`. Use `--region us-east5` (or `GOOGLE_CLOUD_LOCATION`) to pin a region.
- Project comes from `--project`, then `SYNAPSE_LLM_PROJECT`, then the saved config, then `GOOGLE_CLOUD_PROJECT`.

For a one-off build without saving anything: `synapse build --local --provider vertex --llm-project my-proj --llm-region us-east5`.

### Checking that a key was picked up

`synapse model` reports the resolved key **and where it came from**, so a key that isn't being read is visible before a build rather than after:

```
  Provider        Groq (project)
  API key         gsk_t*************** (env GROQ_API_KEY)
```

`keySource` is one of `flag`, `env <VAR>`, `stored`, or `(not set)`. If a required key is missing, Synapse names the variable to set and links the provider's key page instead of failing mid-build.

## Provider differences Synapse handles for you

The OpenAI chat-completions contract is not implemented identically everywhere. Synapse carries four capability flags per provider and adjusts the request; you don't configure any of this for the built-in providers.

| Provider | Divergence | What Synapse does |
|---|---|---|
| **Ollama** | Documents `tool_choice` as **unsupported** | Sends `response_format: {"type":"json_object"}` and inlines the JSON Schema into the system prompt instead of forcing a tool call |
| **OpenAI** | `max_tokens` is deprecated and *rejected* by reasoning models | Sends `max_completion_tokens` — accepted by their non-reasoning models too, so it is safe for both |
| **OpenAI** | Reasoning models (gpt-5, o-series) reject `temperature` | Omits the field rather than guessing per model |
| **Groq** | `temperature: 0` is silently converted to `1e-8` | Nothing needed — handled server-side |
| **OpenRouter** | Wants attribution headers | Sends `HTTP-Referer` and `X-Title` automatically |
| **Anthropic** | Native `tool_use` + ephemeral prompt caching | Uses its own adapter and the official SDK, so the default path is unchanged and caching still applies to the classifier's system prefix |

Why this matters: every stage of local codegen is a single **forced tool call** returning JSON that matches a strict schema. `tool_choice` is how that is normally enforced — so a provider that ignores it needs a second path, not a warning.

Both paths are always tolerated on the way back. Tools are advertised even on the JSON path, so a model that *can* call them still does; and extraction accepts either a `tool_calls` entry or a JSON object in the message content, regardless of which was requested. A server that claims to support `tool_choice` and quietly ignores it therefore still works.

> **Model capability, not API capability.** The JSON fallback makes weaker models *reachable*, not *competent*. Codegen needs a model that can hold a strict schema; small local models often can't, and fail with `returned no emit_tool_plan call`. The fix is a stronger model, and the error message says so.

### Your own inference endpoint

Anything exposing `POST {base_url}/chat/completions` with the OpenAI request/response shape works — vLLM, TGI, LM Studio, llama.cpp, SGLang, an internal gateway, or your own GPU cluster:

```bash
synapse model set custom \
  --base-url http://gpu.internal:8000/v1 \
  --model qwen3-coder-30b \
  --header "X-Route: a100"          # repeatable
```

Because Synapse can't probe your server, partial compatibility is something you declare. These are the same flags as the capability table above, exposed for `custom`:

| Flag | Use when | Effect |
|---|---|---|
| `--no-tool-choice` | Server ignores or rejects `tool_choice` | Switches to JSON mode + schema in the prompt |
| `--max-completion-tokens` | Server wants the newer field name | Sends `max_completion_tokens` instead of `max_tokens` |
| `--no-temperature` | Server rejects `temperature` | Omits the field |

A key is optional for `custom`. When supplied (via `SYNAPSE_LLM_API_KEY`, `--llm-api-key`, or `--save-key`) it is sent as `Authorization: Bearer <key>`.

## Config schema

`synapse model set` writes an `llm` block to `.synapse/config.json`, or to `~/.synapse/config.json` with `--global`. You can also hand-write it.

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `provider` | `"anthropic" \| "openai" \| "groq" \| "grok" \| "openrouter" \| "ollama" \| "custom" \| "bedrock" \| "vertex"` | **yes** | — |
| `base_url` | string (valid URL) | only for `custom` | Overrides the provider default. Endpoint **root** — `/chat/completions` is appended. |
| `models.triage` | string | no | High-volume candidate classification. Cheap model. |
| `models.generate` | string | no | Code generation. Strongest model. |
| `models.verify` | string | no | Verification and repair. |
| `models.fallback_generate` | string | no | Used after repeated overload responses on the primary. |
| `headers` | `{ [name]: string }` | no | Extra request headers, merged over provider defaults. |
| `tool_choice` | boolean | no | `false` = endpoint ignores `tool_choice`; use JSON mode. |
| `max_tokens_field` | `"max_tokens" \| "max_completion_tokens"` | no | Output-cap field name. |
| `temperature` | boolean | no | `false` = omit `temperature`. |
| `region` | string | no | `bedrock`: AWS region. `vertex`: Vertex location. |
| `project` | string | no | `vertex`: GCP project id. |
| `aws_profile` | string | no | `bedrock`: named AWS profile. |
| `api_key_prefix` | string | no | First 5 chars, for display only. Written by `--save-key`. |
| `api_key_encrypted` | string | no | Fernet ciphertext, machine-bound. Written by `--save-key`. |

Any subset of `models` is valid — unset stages fall back to that provider's defaults. Omitted capability fields fall back to the provider's built-in flags.

### Example

```jsonc
{
  "llm": {
    "provider": "custom",
    "base_url": "http://gpu.internal:8000/v1",
    "models": {
      "triage": "qwen3-4b",
      "generate": "qwen3-coder-30b",
      "verify": "qwen3-coder-30b",
      "fallback_generate": "qwen3-4b"
    },
    "headers": { "X-Route": "a100" },
    "tool_choice": false,
    "api_key_prefix": "sk-in",
    "api_key_encrypted": "gAAAAAB…"
  }
}
```

### Validation

The block is schema-validated on every read and is **strict** — an unknown or misspelled key is rejected rather than silently ignored. An invalid block does not fail your build: Synapse prints a warning naming the offending field and falls back to the next source in the resolution order.

### Resolution order

Provider, model and endpoint resolve independently, highest first:

1. CLI flags — `--provider`, `--model`, `--llm-base-url`
2. Env — `SYNAPSE_LLM_PROVIDER`, `SYNAPSE_LLM_MODEL`, `SYNAPSE_LLM_BASE_URL`
3. Project `.synapse/config.json` → `llm`
4. Global `~/.synapse/config.json` → `llm`
5. Anthropic with its default models

Keys resolve on their own track: `--llm-api-key` flag → the provider's env var → `SYNAPSE_LLM_API_KEY` → a `--save-key` stored value.

Stored `models` and capability flags apply **only to the provider they were saved for**. Switching provider with `--provider` never inherits the previous provider's model ids.

### Environment variables

| Variable | Purpose |
|---|---|
| `SYNAPSE_LLM_PROVIDER` | Provider id, overriding stored config |
| `SYNAPSE_LLM_MODEL` | Model id — pins every stage |
| `SYNAPSE_LLM_BASE_URL` | Endpoint root, overriding stored config |
| `SYNAPSE_LLM_API_KEY` | Key fallback for any provider |
| `SYNAPSE_LLM_TIMEOUT_MS` | Per-request timeout, default `300000` (5 min). Raise it for slow local inference. |
| `SYNAPSE_TELEMETRY=0` | Opt out of anonymous usage telemetry. Hosted quota checks and line-count reporting still run (see [What leaves your machine](#what-leaves-your-machine)) |

Plus the provider-specific key variables in the table above.

## Where keys are stored

By default, **nowhere**. Inference keys are read from the environment (or a flag) on every invocation and never written to disk.

`synapse model set <provider> --save-key <key>` is an explicit opt-in. It stores the key Fernet-encrypted (AES-128-CBC + HMAC-SHA256) under a key derived from your username and hostname, so the file will not decrypt on another machine — moving the config elsewhere yields a warning telling you to re-enter it, not a silent failure. Only a 5-character prefix is stored in cleartext, for display. Remove it with `synapse model reset`.

Use `--global` to apply any of this to `~/.synapse` instead of the current project.

## Features

- **Bring your own model** — local builds run on Anthropic, OpenAI, Groq, xAI (Grok), OpenRouter, Ollama, Amazon Bedrock, Google Vertex AI, or any OpenAI-compatible endpoint you host. Switch with one command; no quota, and nothing goes to Synapse except anonymous telemetry.
- **Zero boilerplate** — tool schemas, argument validation, and MCP wire format handled for you.
- **Client-side extraction** — language detection and route/function extraction run on your machine with tree-sitter.
- **Reads 6 languages** — Auto mode reads Python, TypeScript, Java, C#, Go and Rust. Custom mode reads Python. Generated server files are Python. See [Build modes](#build-modes-auto-and-custom).
- **Streaming gRPC** — live progress from the backend while your server is generated.
- **Deterministic surface extraction** — tree-sitter parsers with a 64KB head-sniff make repeat runs cache-friendly.
- **Signed API keys** — Ed25519 envelope keys, per-request quota, revocation in under 30 seconds.

## Commands

| Command | Purpose |
|---|---|
| `synapse init [--force]` | Initialize Synapse in the current project. Uses the key from `SYNAPSE_API_KEY`, the project or `~/.synapse` (or prompts for one) and checks it with the backend. |
| `synapse build [--auto \| --custom] [-q <query>] [--smart-names] [--local] [--resume]` | Generate an MCP server with the v2 engine. Without `--auto`/`--custom`, asks which mode. `-q` describes the Custom-mode tool. |
| `synapse build --auto [--all-endpoints \| --endpoints <list>]` | Pick Auto-mode endpoints without the interactive picker (for CI). `<list>` is comma-separated `"METHOD /path"`, `/path` or tool names. |
| `synapse build --auto [--server-name <name>] [--new]` | Rebuilds update the project's existing MCP server (same server id). `--new` creates another server; `--server-name` picks which one. |
| `synapse build --engine v1 [-q <query>] [-o <file>] [--no-validate] [--no-docs] [-g]` | Legacy v1 engine (hosted, Python only). Needs `synapse analyze` first. |
| `synapse analyze [-o <dir>] [-v]` | Scan Python code and write the symbol/schema map the v1 engine uses. |
| `synapse config` | Show settings: the API key in use (redacted) and where it comes from, saved keys, project, endpoints and the local-build provider. |
| `synapse config set-key [<key>] [--global]` | Check a Synapse API key with the backend, then save it encrypted. Prompts when `<key>` is omitted. `--key <k>` and `--update` are aliases. |
| `synapse config keys` | List the active API keys on your account. |
| `synapse config revoke <id> [--yes]` | Revoke an API key on your account. |
| `synapse model` | Show the inference provider local builds use. |
| `synapse model list` | List supported providers and their default models. |
| `synapse model set <provider> [--model <id>] [--base-url <url>] [--save-key <k>] [--global]` | Switch provider for local builds. |
| `synapse model reset [--global]` | Remove the saved inference config. |
| `synapse info` | Show project state and account quota. |
| `synapse update` | Update the CLI to the latest npm release. |
| `synapse uninstall` | Remove global config and uninstall. |

Add `--dev` to any command to talk to a local backend on `localhost:50051`.

## Configuration

Config is resolved in this order:

1. Environment variables (`SYNAPSE_API_KEY`, `SYNAPSE_BACKEND_URL`, `SYNAPSE_API_URL`, `SYNAPSE_DEV=1`)
2. Project-local `./.synapse/config.json`
3. Global `~/.synapse/config.json`

This covers the hosted service.

### Synapse API key

- `synapse config set-key` checks the key with the backend before saving it. A key the backend rejects is not saved, and your current key stays. If the backend can't be reached, the key is saved with a warning. Run it without `<key>` to type the key at a masked prompt, which keeps it out of your shell history.
- The key is always saved to `~/.synapse`. If the current project already has its own saved key, that one is replaced too, because it would otherwise take precedence. `--global` saves to `~/.synapse` only. Nothing is created in a directory that isn't a Synapse project.
- `SYNAPSE_API_KEY` overrides every saved key. `synapse config` names the source in use and warns you when the environment variable is set.
- To rotate a key: create a new one in the console, run `synapse config set-key`, then `synapse config keys` and `synapse config revoke <old id>`. Revoking needs confirmation. If you revoke the key the CLI is using, it warns you, and every later command fails until you save a new key. A revoked key is rejected by the API at once and by the build backend within about 30 seconds.

### Default endpoints

| Service | Default | Override |
| --- | --- | --- |
| gRPC backend | `grpc.synapse.2ndbrainlabs.ai:443` | `SYNAPSE_BACKEND_URL` |
| REST API (quota, telemetry) | `https://api.synapse.2ndbrainlabs.ai` | `SYNAPSE_API_URL` |
| Hosted MCP servers | `https://mcp.synapse.2ndbrainlabs.ai` | — |
| Console | `https://synapse.2ndbrainlabs.ai` | — |

Since 0.1.7 these replace the earlier `*.synaps3.ai` hostnames. The old hostnames keep serving for now, so a `SYNAPSE_BACKEND_URL` / `SYNAPSE_API_URL` that still points at them keeps working; switch to the new names when convenient.

The inference provider used by `--local` builds is configured separately — see [Config schema](#config-schema) and [Providing your API key](#providing-your-api-key).

## How `build` works

With the default v2 engine:

1. **Scan (local).** The CLI detects the project language and extracts HTTP routes (and, in Custom mode, public functions) with tree-sitter. This runs on your machine; the scan can be paused and continued with `--resume`.
2. **Pick.** You choose Auto or Custom, then the endpoints or functions to expose.
3. **Generate.** Auto mode saves the endpoint config to your Synapse account (hosted) or writes a passthrough server (`--local`). Custom mode sends the extracted manifest and your description to the backend (hosted) or to your model (`--local`), which composes the tool; it is checked and written to your project as a Python file.

The legacy v1 engine (`--engine v1`) works differently: a hosted agent explores the code by asking the CLI to run `read_file`, `grep`, `list_symbols` and similar tools, so the contents of the files it asks for are sent to the backend.

## What leaves your machine

| Build | Sent to | What is sent |
|---|---|---|
| Hosted Auto | Synapse API | For each endpoint you select: name, description (from the docstring), HTTP method, route path, header names with `${ENV}` placeholders, and an example payload. Saved to your account as the MCP server config. |
| Hosted Auto + `--smart-names` | Synapse backend | The above, plus the **source code** of each selected handler (up to 3,000 characters each) and up to 6,000 characters of your README / `docs/` files. |
| Hosted Custom | Synapse backend | The extracted manifest: module and function names, signatures, docstrings (trimmed), file paths and line numbers, and route metadata, plus your workflow description. Function bodies are not sent by the CLI. |
| Hosted v1 (`--engine v1`) | Synapse backend | The project schema from `synapse analyze`, plus the contents of the files, search results and symbols the agent asks for. |
| `--local` | Your chosen model provider | Custom mode and `--smart-names` send the same kind of content as the hosted rows above. Auto mode without `--smart-names` calls no model. Nothing goes to Synapse except telemetry. |
| Telemetry (all modes) | Synapse API | Event name, mode, counts, model name, token counts and timings, plus SHA-256 hashes of your working directory path, your machine/user and (for `--local` model calls) each prompt. Hosted events are tied to your API key. No code, no prompts. Turn off with `SYNAPSE_TELEMETRY=0`. |
| Quota (hosted builds and `synapse analyze`) | Synapse API | A quota check before the build, and the number of newly indexed lines, both authenticated with your API key. Sent even with `SYNAPSE_TELEMETRY=0`, because the free-tier limit is enforced from it; with telemetry off the line count goes alone (event name, line count, mode), with no hashes, installation id or CLI version. Not sent for `--local` builds. |

Hosted smart naming and Custom mode do read your code. We don't log or host your code. For hosted Auto builds, your account stores the endpoint config listed above so the runner can serve your tools.

## Language support

| Language | Detected and scanned | Auto mode | Custom mode | Generated file |
|---|---|---|---|---|
| Python | ✅ | ✅ | ✅ | Python |
| TypeScript (`.ts`, `.tsx`) | ✅ | ✅ hosted; `--local` names tools only | — | — |
| Java, C#, Go, Rust | ✅ | ✅ hosted; `--local` names tools only | — | — |
| JavaScript (`.js`, `.jsx`) | — | — | — | — |

Hosted Auto mode writes no file for any language: the hosted runner serves the tools.

## Troubleshooting

| Message | Fix |
|---|---|
| `Not Initialized` on `build` | Run `synapse init` |
| `Analysis Required` (with `--engine v1`) | Run `synapse analyze` |
| `Quota Exceeded` | Check `synapse info`. The free tier allows 10 MCP servers and 100,000 indexed lines. |
| `Your Synapse API key is invalid or expired` `[AUTH_INVALID]` | Save a valid key with `synapse config set-key`, or set `SYNAPSE_API_KEY` (it overrides saved keys). |
| `Endpoint Selection Required` | No terminal to pick endpoints in. Pass `--all-endpoints` or `--endpoints <list>`. |
| `The Synapse server hit an internal error` `[SERVER_ERROR]` | A server-side problem, not your code or key. Report it with the `Session:` id. |
| Backend error mid-build | The CLI retries transient errors. Quote the `Session:` id when opening an issue. |

## Documentation

- **Getting started** — [synapse.2ndbrainlabs.ai/docs](https://synapse.2ndbrainlabs.ai/docs)
- **API reference** — [synapse.2ndbrainlabs.ai/docs/api](https://synapse.2ndbrainlabs.ai/docs/api)
- **Examples** — [github.com/2ndbrainlabs-ai/synapse-examples](https://github.com/2ndbrainlabs-ai/synapse-examples)

## Development

```bash
git clone https://github.com/2ndbrainlabs-ai/synapse-cli-ts.git
cd synapse-cli-ts
npm install
npm run dev -- <command>        # run against source
npm run build                   # produce dist/
npm test                        # vitest suite
npm run typecheck
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/blob/main/CONTRIBUTING.md) for how to file issues, run the test suite, and open a PR. All participation is subject to our [Code of Conduct](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/blob/main/CODE_OF_CONDUCT.md).

## Security

Please review our [Security Policy](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/blob/main/SECURITY.md) before reporting vulnerabilities.

## License

Licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). See [NOTICE](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/blob/main/NOTICE) for attribution.

---

## Star History

<a href="https://star-history.com/#2ndbrainlabs-ai/synapse-cli-ts&Date">
  <img src="https://api.star-history.com/svg?repos=2ndbrainlabs-ai/synapse-cli-ts&type=Date" alt="Star History Chart" width="600" />
</a>

---

<div align="center">

Built by [2nd Brain Inc.](https://2ndbrainlabs.ai)

</div>
