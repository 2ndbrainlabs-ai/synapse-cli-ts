<div align="center">

<img src="https://unpkg.com/@2ndbrainlabs-ai/synapse-cli/docs/logo.png" alt="Synapse" width="360" />

### Enterprise Context Engine

**Today: MCP Servers. Tomorrow: Every Context Surface Your Stack Needs.**

Turn any codebase into a production-ready [Model Context Protocol](https://modelcontextprotocol.io) server — from your terminal, in seconds.

[Homepage](https://synaps3.ai) · [Docs](https://synaps3.ai/docs) · [Report an issue](https://github.com/2ndbrainlabs-ai/synapse-cli/issues) · [Discussions](https://github.com/2ndbrainlabs-ai/synapse-cli/discussions)

[![npm version](https://img.shields.io/npm/v/@2ndbrainlabs-ai/synapse-cli.svg?logo=npm&color=D97757)](https://www.npmjs.com/package/@2ndbrainlabs-ai/synapse-cli)
[![node](https://img.shields.io/node/v/@2ndbrainlabs-ai/synapse-cli.svg?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/License-Apache_2.0-green.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![downloads](https://img.shields.io/npm/dm/@2ndbrainlabs-ai/synapse-cli.svg?color=blue)](https://www.npmjs.com/package/@2ndbrainlabs-ai/synapse-cli)

</div>

---

## What is Synapse?

Synapse is building the context layer enterprises need to make their internal systems agent-ready. Today, we're open-sourcing the first piece of that vision: an agentic MCP server generator that analyzes existing codebases and generates production-ready MCP servers.

Synapse is a CLI that reads your codebase and generates a runnable MCP server — the tool schemas, argument marshalling, and boilerplate are all handled for you. Point it at a project, describe what you want exposed, and drop the resulting server into Claude Desktop, Cursor, or any MCP-compatible client.

The CLI does source exploration **client-side** — nothing is uploaded. Generation runs on the Synapse backend by default, so model routing, retries, and quota stay centrally managed — or entirely on your own model with `--local`, using Anthropic, OpenAI, Groq, xAI, OpenRouter, Ollama, or your own inference endpoint. See [Run locally with your own model](#run-locally-with-your-own-model).

## Install

```bash
npm install -g @2ndbrainlabs-ai/synapse-cli
```

Requires **Node.js 18+**. Verify with `synapse --version`.

## Quick start

```bash
cd my-project
synapse init                    # one-time: paste your API key
synapse analyze                 # scans code, writes .synapse/schema.json
synapse build                   # discovers use cases, prompts you to pick
```

The generated server lands at `./mcp_server.py`. Copy the printed JSON snippet into your MCP client config and you're done.

Prefer to describe it yourself:

```bash
synapse build --query "Expose user auth and profile lookup as MCP tools"
```

## Run locally with your own model

Skip the hosted Synapse service entirely — codegen runs in-process using **your** inference provider. No quota, no code upload, no signup required.

```bash
export ANTHROPIC_API_KEY=sk-ant-…

cd my-project
synapse build --local           # generates locally on your own key
```

`--local` is a **per-invocation** flag — no project config pins a repo to local mode, so switching back is just dropping the flag. `synapse init` is not required for a local build.

Locally-generated servers don't count against any quota; analyze runs are unbounded. Anonymous usage telemetry (no code, no prompts — just event names + counts) still flows to `api.synaps3.ai`; opt out with `SYNAPSE_TELEMETRY=0`.

**Local-mode limits:**
- Python target only (TypeScript target follows).
- Auto flow (`--auto`) requires the hosted service. Use `--custom` (the default in local mode).
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
| `provider` | `"anthropic" \| "openai" \| "groq" \| "grok" \| "openrouter" \| "ollama" \| "custom"` | **yes** | — |
| `base_url` | string (valid URL) | only for `custom` | Overrides the provider default. Endpoint **root** — `/chat/completions` is appended. |
| `models.triage` | string | no | High-volume candidate classification. Cheap model. |
| `models.generate` | string | no | Code generation. Strongest model. |
| `models.verify` | string | no | Verification and repair. |
| `models.fallback_generate` | string | no | Used after repeated overload responses on the primary. |
| `headers` | `{ [name]: string }` | no | Extra request headers, merged over provider defaults. |
| `tool_choice` | boolean | no | `false` = endpoint ignores `tool_choice`; use JSON mode. |
| `max_tokens_field` | `"max_tokens" \| "max_completion_tokens"` | no | Output-cap field name. |
| `temperature` | boolean | no | `false` = omit `temperature`. |
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
| `SYNAPSE_TELEMETRY=0` | Opt out of anonymous usage telemetry |

Plus the provider-specific key variables in the table above.

## Where keys are stored

By default, **nowhere**. Inference keys are read from the environment (or a flag) on every invocation and never written to disk.

`synapse model set <provider> --save-key <key>` is an explicit opt-in. It stores the key Fernet-encrypted (AES-128-CBC + HMAC-SHA256) under a key derived from your username and hostname, so the file will not decrypt on another machine — moving the config elsewhere yields a warning telling you to re-enter it, not a silent failure. Only a 5-character prefix is stored in cleartext, for display. Remove it with `synapse model reset`.

Use `--global` to apply any of this to `~/.synapse` instead of the current project.

## Features

- **Bring your own model** — local builds run on Anthropic, OpenAI, Groq, xAI (Grok), OpenRouter, Ollama, or any OpenAI-compatible endpoint you host. Switch with one command; no quota, no code upload.
- **Zero boilerplate** — tool schemas, argument validation, and MCP wire format handled for you.
- **Client-side exploration** — grep, AST symbol lookup, and definition/usage tracing all run on your machine.
- **First-class Python + TypeScript** — full symbol and navigation support. Go, Java, C#, Rust get grep-based fallback.
- **Streaming gRPC** — bidirectional session with the agent so you can watch tool calls land in real time.
- **Deterministic surface extraction** — tree-sitter parsers with a 64KB head-sniff make repeat runs cache-friendly.
- **Signed API keys** — Ed25519 envelope keys, per-request quota, revocation in under 30 seconds.

## Commands

| Command | Purpose |
|---|---|
| `synapse init [--force]` | Initialize Synapse in the current project. Prompts for API key. |
| `synapse analyze [-o <dir>] [-v]` | Scan the codebase and build a symbol/schema map. |
| `synapse build [-q <query>] [-o <file>] [--no-validate] [--no-docs] [-g]` | Generate an MCP server. Without `-q`, discovers candidate use cases. |
| `synapse config [--update] [--key <k>] [--global]` | View or update config. |
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

1. Environment variables (`SYNAPSE_API_KEY`, `SYNAPSE_BACKEND_URL`, `SYNAPSE_DEV=1`)
2. Project-local `./.synapse/config.json`
3. Global `~/.synapse/config.json`

This covers the hosted service. The inference provider used by `--local` builds is configured separately — see [Config schema](#config-schema) and [Providing your API key](#providing-your-api-key).

## How `build` works

`synapse build` opens a bidirectional gRPC stream with the backend agent. The agent never sees your code — it *asks the CLI* for exactly what it needs:

- `read_file`, `find_files`, `grep` — bounded reads over your working directory
- `list_symbols`, `find_definition`, `find_usages` — AST navigation via tree-sitter
- `write_file`, `replace_file`, `insert_file` — final artifact writes

Every tool call is scoped to `process.cwd()`. Only the specific bytes the agent asks for flow back over the wire.

## Language support

| Language | Symbol extraction | Discovery | Generation |
|---|---|---|---|
| Python | ✅ | ✅ | ✅ |
| TypeScript / JavaScript / TSX / JSX | ✅ | ✅ | ✅ |
| Go, Java, C#, Rust | grep + patterns | partial | best-effort |

## Troubleshooting

| Message | Fix |
|---|---|
| `Not Initialized` on `build` | Run `synapse init` |
| `Analysis Required` | Run `synapse analyze` |
| `Quota Exceeded` | Check `synapse info` |
| Backend error mid-build | The CLI retries transient errors. Quote the `Session:` id when opening an issue. |

## Documentation

- **Getting started** — [synaps3.ai/docs](https://synaps3.ai/docs)
- **API reference** — [synaps3.ai/docs/api](https://synaps3.ai/docs/api)
- **Examples** — [github.com/2ndbrainlabs-ai/synapse-examples](https://github.com/2ndbrainlabs-ai/synapse-examples)

## Development

```bash
git clone https://github.com/2ndbrainlabs-ai/synapse-cli.git
cd synapse-cli
npm install
npm run dev -- <command>        # run against source
npm run build                   # produce dist/
npm test                        # vitest suite
npm run typecheck
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/2ndbrainlabs-ai/synapse-cli/blob/main/CONTRIBUTING.md) for how to file issues, run the test suite, and open a PR. All participation is subject to our [Code of Conduct](https://github.com/2ndbrainlabs-ai/synapse-cli/blob/main/CODE_OF_CONDUCT.md).

## Security

Please review our [Security Policy](https://github.com/2ndbrainlabs-ai/synapse-cli/blob/main/SECURITY.md) before reporting vulnerabilities.

## License

Licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). See [NOTICE](https://github.com/2ndbrainlabs-ai/synapse-cli/blob/main/NOTICE) for attribution.

---

<div align="center">

Built by [2nd Brain Inc.](https://2ndbrainlabs.ai)

</div>
