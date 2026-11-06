# AGENTS.md

Instructions for every coding agent (Claude Code, Cursor, Codex, Copilot, Gemini) and for humans. This file is the single source of truth. Agent-specific files (`CLAUDE.md`, `.claude/`) only point here.

This is a **public** repository. Everything you write here (code, docs, tests, commit messages, PR descriptions) is visible to anyone.

## What this repo is

`@2ndbrainlabs-ai/synapse-cli`, the `synapse` binary: a Node ESM TypeScript CLI that reads a codebase and generates a runnable MCP server (Python / FastMCP today).

- **Code exploration always runs on the user's machine** (tree-sitter surface extraction).
- **Code generation** runs either on the hosted Synapse backend over gRPC (the default) or in-process on the user's own model with `--local`.
- **Stack:** TypeScript (strict), commander, `@grpc/grpc-js`, tree-sitter, zod, vitest, tsup, ESLint.
- **Distribution:** npm, published by release-please from GitHub Actions. See [docs/RELEASING.md](docs/RELEASING.md).

Read [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci --legacy-peer-deps` | Install exactly what CI installs |
| `npm run dev -- <command> [flags]` | Run the CLI from source with tsx (e.g. `npm run dev -- build --local`) |
| `npm run build` | tsup bundle into `dist/` |
| `npm run lint` | ESLint over `src/` and `tests/` |
| `npm run typecheck` | `tsc --noEmit` on `src/` only |
| `npm run typecheck:tests` | Typecheck `src/` and `tests/` (`tsconfig.test.json`) |
| `npm test` | `vitest run`, the whole suite |
| `npx vitest run <file>` / `npx vitest run -t "<name>"` | One test file / tests matching a name |
| `npm run ci` | lint + typecheck + typecheck:tests + test + build. **Run this before you say a task is done.** |
| `npm audit --audit-level=high` | The dependency audit CI runs |
| `npm pack --dry-run` | List exactly what would be published to npm |

More detail, including the local-backend `--dev` flag: [docs/development.md](docs/development.md).

## Directory map

```
src/index.ts             commander entry: every command, lazy-imported handlers, global --yes / --dev
src/commands/            One module per command (init, config, model, info, logs, update, uninstall, ...)
src/commands/v2/         The default build engine: Auto and Custom tracks
src/extractors/          Deterministic tree-sitter surface extraction (core/ + languages/)
src/backend/             In-process codegen pipeline for --local (classify, shape, render, verify)
src/providers/           LLM adapters for --local (Anthropic, OpenAI-compatible, Bedrock, Vertex)
src/grpc/                Hosted client (gRPC), client factory, REST telemetry and quota
src/config/              Config resolution, paths, LLM config, encrypted key storage
src/session/             Append-only build session ledger (--resume, synapse logs)
src/ui/                  Theme, prompts, boxes, spinners: all terminal output goes through here
src/utils/               Small helpers (hashing, env, version checks)
protos/                  synapse.proto and the wire manifest schema (shipped in the package)
tests/unit/              vitest unit tests, mirroring src/
tests/integration/       vitest integration tests
tests/fixtures/          Sample repos in several languages for extractor tests
docs/                    Contributor docs and playbooks. Read the relevant one before starting
.claude/skills/          Claude Code skills; thin wrappers around docs/playbooks/
```

Path note: source imports use `.js` extensions (`../config/paths.js`), as Node16 module resolution requires. Tests import source the same way.

## Pick your playbook

| Task | Read first |
| --- | --- |
| Add a new LLM provider for `--local` | [docs/playbooks/add-provider.md](docs/playbooks/add-provider.md) |
| Add or change a CLI command or flag | [docs/playbooks/add-command.md](docs/playbooks/add-command.md) |
| Add tests for existing code or a bug fix | [docs/playbooks/add-tests.md](docs/playbooks/add-tests.md) |
| Security review of a change or the whole repo | [docs/playbooks/security-audit.md](docs/playbooks/security-audit.md) |

Reference docs:

- [architecture](docs/architecture.md): engines, extractors, providers, hosted vs local, telemetry
- [development](docs/development.md): setup, commands, running against source
- [testing](docs/testing.md): vitest conventions, isolation, what to mock
- [security](docs/security.md): secrets, key storage, what ships in the npm package
- [releasing](docs/RELEASING.md): Conventional Commits, release-please, version bumps, npm publishing
- [agent-setup](docs/agent-setup.md): how the agent files fit together
- [domain docs](docs/agents/domain.md) and [CONTEXT.md](CONTEXT.md): the glossary. Use its terms in code, tests and PRs

## Hard rules

1. **Never commit secrets.** No `.env` files, API keys, tokens, `*.pem` or private keys in git, code, tests, fixtures or logs. Tests use obvious fakes (`sk-test-…`, `syn_test_…`). See [docs/security.md](docs/security.md).
2. **Nothing secret ships in the npm package.** `files` in `package.json` is an allowlist (`dist`, `protos`, `config.json`, `docs/logo.png`). Don't widen it without checking `npm pack --dry-run`. `config.json` holds public endpoints only.
3. **Keys stay on the user's machine.** Inference keys come from the environment or a flag and are never written to disk unless the user passes `--save-key`. Never log, print or send a key; display only the stored prefix.
4. **Respect the privacy contract.** The README section "What leaves your machine" is a promise to users. A change that sends new data to the Synapse service or to a model provider must update that table in the same PR. `SYNAPSE_TELEMETRY=0` must keep disabling analytics events.
5. **Both clients keep the same shape.** `SynapseClient` (hosted) and `LocalSynapseClient` (`--local`) implement `ISynapseClient`. Change both, or neither.
6. **`--local` is per invocation.** It's read from the flag only; never persist `"mode": "local"` in config.
7. **Wire contracts change together.** `src/extractors/core/manifest-wire.ts` must match `protos/wire-manifest.schema.json` (enforced by `tests/unit/extractors/manifest-wire.contract.test.ts`), and `protos/synapse.proto` must match the backend. Changing a required field is a coordinated change with the maintainers.
8. **TypeScript strict.** No new `any` or `@ts-ignore`. Prefix unused args and vars with `_`. Lint must have 0 errors.
9. **Terminal output goes through `src/ui/`** (`theme.ts`, `box.ts`, `prompt.ts`) so TTY and non-TTY output match. Prompts must honour `--yes` / non-TTY (`SYNAPSE_NON_INTERACTIVE=1`).
10. **No new runtime dependencies** without discussion in an issue first. Install size matters.
11. **Every bug fix ships with a test that fails without the fix.** Run `npm run typecheck:tests` after changing a signature that tests use.
12. **Public repo hygiene.** No internal URLs, hostnames, project IDs, ticket-tracker links or customer data in code, docs, commits or PRs. Public endpoints already in the README are fine.

## Git and PRs

- Branch from `main`. PRs go to `main`. Never push to `main` directly, never force-push a shared branch.
- **PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) with a lowercase subject** (`feat(cli): add --smart-names flag`), enforced by CI. PRs are squash-merged, so the title becomes the commit release-please reads. The type decides the version bump: see [docs/RELEASING.md](docs/RELEASING.md).
- Keep PRs to one concern. Say what and why, and how you tested it.
- CI must pass: Unit Tests, Lint, Security Audit (`npm audit --audit-level=high`), Integration Checks (typecheck, test typecheck, build), and the PR-title check.

## Issues

Contributors use [GitHub issues](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues). Maintainers also track work in an internal tracker; ticket keys may appear in branch names and PR titles, but links to it don't belong in this repo. Report vulnerabilities as described in [SECURITY.md](SECURITY.md), not in a public issue.
