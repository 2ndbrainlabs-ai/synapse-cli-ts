# Playbook: security audit

Review a diff or the whole repo against [../security.md](../security.md). The output is a list of findings, not code changes, unless you were asked to fix them.

**This repo is public.** Deliver findings privately to the person who asked (or to the maintainers per [SECURITY.md](../../SECURITY.md)). Never put exploitable details in a commit, PR, issue or public comment. In public, say only that an audit ran and how many findings there were.

## Scope

- **A diff:** `git diff main...HEAD`. Check what changed, plus anything the change calls.
- **The repo:** run every check below.

**Never open, print or paste secret files** (`.env*`, key files, `~/.synapse/config.json`) while auditing. Report that a file exists and where; that's enough. Never print a secret value in the report: give the file, line and kind of secret.

## Checks

Run each search from the repo root. A hit is not automatically a finding: read the code around it.

| # | Check | How to find it |
| --- | --- | --- |
| 1 | **Committed secrets** | `git ls-files \| grep -Ei '(^\|/)\.env($\|\.)\|\.pem$\|\.key$\|credential\|secret'` and `git grep -nEi '(api[_-]?key\|secret\|token\|password)["\x27]?\s*[:=]\s*["\x27][A-Za-z0-9_\-]{16,}'`. Ignore obvious test fakes. Also scan history for high-risk patterns: `git log -p --all -G'sk-ant-\|sk-[A-Za-z0-9]{20}\|AKIA[0-9A-Z]{16}\|-----BEGIN' --oneline \| head` |
| 2 | **Ignore rules** | `git check-ignore -v .env .env.local key.pem` prints a rule for each; `.claude/settings.json` denies reading them |
| 3 | **Package contents** | `npm run build && npm pack --dry-run`: only `dist/`, `protos/`, `config.json`, `docs/logo.png` and npm's defaults. `config.json` has no secrets. Source maps in `dist/` don't embed anything sensitive |
| 4 | **Key storage** | `src/config/api-key-store.ts`, `src/config/manager.ts`, `src/config/llm-config.ts`: keys only written with explicit user action (`set-key`, `init`, `--save-key`); encrypted; file permissions on `~/.synapse` files; cleartext limited to the display prefix |
| 5 | **Keys in output** | `git grep -nE '(console\.(log\|error\|warn)\|stepInfo\|stepWarn\|roundedBox\|sectionBox)\(.*([Aa]pi[_-]?[Kk]ey\|token\|secret)'`: anything that could print a full key, including error messages that echo request config or headers |
| 6 | **Keys sent to the wrong place** | where keys go into headers (`Authorization`, `x-api-key`, gRPC metadata): the Synapse key only to the Synapse endpoints, inference keys only to their provider's base URL. Check that a user-set `--base-url` / `SYNAPSE_BACKEND_URL` / `SYNAPSE_API_URL` is respected and documented, and that insecure (non-TLS) channels are limited to `--dev` / localhost |
| 7 | **Telemetry and traces** | `src/grpc/telemetry.ts`, `src/backend/trace-forwarder.ts`, `src/utils/telemetry-hash.ts`: payloads contain no code, prompts, keys or raw paths; `SYNAPSE_TELEMETRY=0` is honoured; the README "What leaves your machine" table matches the code |
| 8 | **Command execution** | `git grep -nE 'exec(Sync)?\(\|spawn(Sync)?\(\|execFile'`: no shell strings built from file contents, repo paths, flags or env |
| 9 | **Path handling on write** | where the CLI writes into the user's project (generated server, `.env.example`, `.synapse/`): names derived from user code or model output can't escape the project (`..`, absolute paths, symlinks) |
| 10 | **Untrusted model / backend output** | generated code and names from the model or backend are validated (zod schemas in `src/backend/schemas.ts`), not `eval`-ed, and not interpolated into shell commands |
| 11 | **`.env` loading** | `dotenv` loads the current directory's `.env`. Check nothing logs or forwards the whole environment |
| 12 | **Dependencies** | `npm audit --audit-level=high`; new runtime deps in `package.json` since the last release; install scripts of new deps |
| 13 | **CI and release** | `.github/workflows/*.yml`: actions pinned to SHAs, least-privilege `permissions`, no `pull_request_target` running PR code, publish only from the release workflow with provenance |

## Report

For each finding:

- **Severity:** critical (exploitable now, or a live secret), high, medium, low, info
- **Where:** `file:line`
- **What:** one sentence
- **Fix:** one sentence

Order by severity, then list the checks that found nothing. A known, documented limitation is still a finding (mark it "known"). Don't create issues for findings in this public repo; hand them to the maintainers privately and let them decide.
