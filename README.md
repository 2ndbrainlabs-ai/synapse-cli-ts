# Synapse CLI

> **Agentic MCP server generator.** Point it at a codebase, describe what you want exposed, and get a working [Model Context Protocol](https://modelcontextprotocol.io) server you can drop into Claude Desktop, Cursor, or any MCP-compatible client.

[![npm version](https://img.shields.io/npm/v/@2ndbrainlabs-ai/synapse-cli.svg)](https://www.npmjs.com/package/@2ndbrainlabs-ai/synapse-cli)
[![node](https://img.shields.io/node/v/@2ndbrainlabs-ai/synapse-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@2ndbrainlabs-ai/synapse-cli.svg)](./LICENSE)

---

## What it does

Synapse turns any project into an MCP server without you writing tool schemas, argument marshalling, or boilerplate.

1. **`synapse init`** — scaffolds `.synapse/` in your repo and links it to your account.
2. **`synapse analyze`** — walks the source tree, extracts a symbol/schema map, and stores it locally.
3. **`synapse build`** — an agent explores your code (grep, AST symbol lookup, definition/usage tracing), figures out what makes sense to expose, and generates a runnable Python MCP server file.

The CLI does the exploration client-side (fast, private, no code upload). The **generation** happens on the Synapse backend so model routing, retries, and quota can be centrally managed.

## Install

```bash
npm install -g @2ndbrainlabs-ai/synapse-cli
```

Requires **Node.js 18+**.

Verify:
```bash
synapse --version
```

## Quick start

```bash
cd my-project
synapse init                    # one-time: paste API key
synapse analyze                 # scans code, writes .synapse/schema.json
synapse build                   # discovers use cases, prompts you to pick
```

That's it. The generated MCP server lands at `./mcp_server.py`. Copy the printed JSON snippet into your MCP client config and you're done.

Prefer to skip discovery and describe it yourself:

```bash
synapse build --query "Expose user auth and profile lookup as MCP tools"
```

## Commands

| Command | Purpose |
|---|---|
| `synapse init [--force]` | Initialize Synapse in the current project. Prompts for API key. |
| `synapse analyze [-o <dir>] [-v]` | Scan the codebase and build a symbol/schema map. Run once, or after significant code changes. |
| `synapse build [-q <query>] [-o <file>] [--no-validate] [--no-docs] [-g]` | Generate an MCP server. Without `-q`, discovers candidate use cases and lets you pick. `-g` reuses the last `todo_list.md`. |
| `synapse config [--update] [--key <k>] [--global]` | View or update config. `--global` writes to `~/.synapse` instead of `./.synapse`. |
| `synapse info` | Show project state and account quota. |
| `synapse update` | Update the CLI to the latest npm release. |
| `synapse uninstall` | Remove global config and uninstall. |

Global flag:

- `--dev` — talk to a local backend on `localhost:50051` instead of the hosted one. Handy for backend development.

## Configuration

Synapse reads config from three places, in order of precedence:

1. Environment variables (`SYNAPSE_API_KEY`, `SYNAPSE_BACKEND_URL`, `SYNAPSE_DEV=1`)
2. Project-local `./.synapse/config.json`
3. Global `~/.synapse/config.json` (fallback for `--key --global`)

Get your API key from your Synapse account and store it once with `synapse init` or `synapse config --key <k> --global`.

## How build works

`synapse build` streams a bidirectional gRPC session with the backend agent. The agent doesn't have your code — it *asks the CLI* for exactly what it needs:

- `read_file`, `find_files`, `grep` — bounded reads over your working directory
- `list_symbols`, `find_definition`, `find_usages` — AST-aware navigation via tree-sitter
- `write_file`, `replace_file`, `insert_file` — final artifact writes

Every tool call is scoped to `process.cwd()`. Nothing gets uploaded; only tool results — which are the specific bytes the agent asked for — flow back over the wire.

When the run finishes you'll see:

```
╭──────── MCP Server Generated ────────╮
│ Tools:     4                          │
│ Resources: 0                          │
│ Output:    mcp_server.py              │
│ Session:   sess_erjc8hxg3ka9          │
╰───────────────────────────────────────╯
```

Include the `Session:` id when reporting an issue — it maps 1:1 to a backend trace.

## Language support

- **Python** — first-class (symbol extraction, use-case discovery, generation)
- **TypeScript / JavaScript / TSX / JSX / MJS / CJS** — full symbol + navigation support
- **Go, Java, C#, Rust** — grep + basic symbol patterns; generation quality varies

The agent falls back to grep-only navigation for languages it can't parse, so it still works — just less precisely.

## Environment variables

| Variable | Purpose |
|---|---|
| `SYNAPSE_API_KEY` | Overrides the stored API key |
| `SYNAPSE_BACKEND_URL` | Override backend URL (default: `grpc.synaps3.ai`) |
| `SYNAPSE_DEV` | Set to `1` for `localhost:50051` (same as `--dev`) |

## Troubleshooting

**"Not Initialized" on `build`.** Run `synapse init` first.

**"Analysis Required".** Run `synapse analyze`. Re-run after significant refactors so the symbol map stays fresh.

**"Quota Exceeded".** Check `synapse info` for your current plan usage.

**Backend errors mid-build.** The CLI retries transient errors automatically and will surface a session id — quote that when opening an issue.

## Development

```bash
git clone <this-repo>
cd synapse-cli-ts
npm install
npm run dev -- <command>        # run against source
npm run build                   # produce dist/
npm test                        # vitest suite
npm run typecheck
```

The `--dev` flag makes the CLI talk to `localhost:50051`, which is what `synapse-cli-backend` binds to by default. See `../synapse-cli-backend/README.md` for backend setup.

## License

MIT
