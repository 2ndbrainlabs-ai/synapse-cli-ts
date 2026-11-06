# Security

Baseline rules for contributors, human or agent. To report a vulnerability, follow [SECURITY.md](../SECURITY.md); don't open a public issue with exploit details.

## 1. Secrets in this repo

This repo is public, and the CLI ships to npm. **It holds no secrets and needs none to build or test.**

Never commit:

- `.env`, `.env.local` or any `.env.*` file (an `.env.example` with empty or fake values is fine)
- `*.pem`, `*.key`, private keys, service-account or credentials JSON files
- API keys, tokens or passwords in code, tests, fixtures, docs, commit messages or PR descriptions

`.gitignore` covers the common file patterns, and `.claude/settings.json` stops Claude Code from reading them. Neither is a substitute for checking `git status` before you commit.

If you commit a secret by accident, tell the maintainers privately (see SECURITY.md) and revoke the secret. Removing the file in a later commit doesn't help; it stays in history.

## 2. Where user secrets live

The CLI handles two kinds of keys. Both stay on the user's machine.

| Key | Where it comes from | Where it's stored |
| --- | --- | --- |
| **Synapse API key** | `SYNAPSE_API_KEY`, or `synapse init` / `synapse config set-key` (masked prompt) | Saved keys go in `~/.synapse/config.json` (and the project's `.synapse/config.json` if it already has one), encrypted. `SYNAPSE_API_KEY` overrides saved keys and is never written. |
| **Inference key** (`--local`) | The provider's env var (e.g. `ANTHROPIC_API_KEY`), `SYNAPSE_LLM_API_KEY`, or `--llm-api-key` for one run | **Not stored** unless the user passes `--save-key`. Then encrypted in the project or global config. Bedrock and Vertex use the cloud SDK's own credential chain and are never stored. |

How saved keys are encrypted (`src/config/api-key-store.ts`): Fernet (AES-128-CBC + HMAC-SHA256) under a key derived with PBKDF2 from the machine's username and hostname. Only a 5-character prefix is stored in cleartext, for display. This binds the file to one machine and keeps keys out of plain sight; it is **not** protection against someone who can already run code as that user. Treat `~/.synapse/` as sensitive, and say so if you change how keys are stored.

Rules for code that touches keys:

- Never print, log, or send a key. Display only `formatApiKeyDisplay(prefix)`.
- Never put a key in a URL, a telemetry event, a trace, an error message or a ledger entry.
- Never write an inference key to disk without `--save-key`.
- Keys go only to the service they belong to: the Synapse key to the Synapse API and backend, an inference key to its provider's endpoint.

## 3. No key ships in the npm package

What's published is controlled by the `files` allowlist in `package.json`:

```
dist/  protos/  config.json  docs/logo.png  (+ package.json, README.md and LICENSE, which npm always adds)
```

- `config.json` contains only the public default endpoints and the version.
- `.env`, `.synapse/`, tests, fixtures and docs other than the logo are not in the allowlist.
- Releases are built and published from GitHub Actions with npm provenance; no npm token lives in the repo (see [RELEASING.md](RELEASING.md)).

Check it whenever you change `files`, `.npmignore` or the build:

```bash
npm run build && npm pack --dry-run
```

and read the file list. Nothing outside the allowlist above should appear.

## 4. What the CLI sends, and to whom

The README section **"What leaves your machine"** is the contract with users. Any change that sends new data (to the Synapse service or to a model provider) updates that table in the same PR.

- Telemetry is metadata only: no source code, no prompts (a hash of the prompt for `--local` traces), hashed paths and machine ids with a local salt. `SYNAPSE_TELEMETRY=0` disables analytics events and `--local` traces.
- Hosted quota checks run even with telemetry off, because the free tier is enforced from them. They send only what the README lists.
- `--local` builds never send code to Synapse.

## 5. Running code on the user's machine

- The CLI reads the user's repository. Treat file contents as untrusted input: no `eval`, no shelling out with interpolated file contents or paths.
- Use `execFile` / `spawn` with an argument array, not `exec` / `execSync` with a string built from input.
- Generated MCP servers are written into the user's project and are theirs to review (see SECURITY.md, "Scope"). Generated code must not embed secrets; it reads them from env vars and lists them in `.env.example`.

## 6. Dependencies

- New runtime dependencies need an issue first. Fewer dependencies, smaller attack surface.
- CI runs `npm audit --audit-level=high`. Fix or justify any high or critical advisory; don't silence it.
- Dependabot opens update PRs; review them like any other change.

## 7. Reviewing for security

Use [playbooks/security-audit.md](playbooks/security-audit.md) (`/security-audit` in Claude Code). In this public repo, **report findings privately to the maintainers**, not in a PR or issue.
