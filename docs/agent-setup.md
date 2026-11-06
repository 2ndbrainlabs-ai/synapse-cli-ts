# Coding agent setup

The repo works the same with any coding agent. Instructions live in [AGENTS.md](../AGENTS.md), procedures in `docs/playbooks/`, and rules are enforced by review and CI, not by any one agent.

## Per-agent files (committed)

| Agent | Instructions | Notes |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` → `@AGENTS.md`; skills in `.claude/skills/` | `.claude/settings.json` allows the read-only dev commands and denies reading secret files |
| Cursor, Codex, GitHub Copilot | `AGENTS.md` (read natively) | |
| Gemini CLI | Point it at `AGENTS.md` (`contextFileName` in your user settings) | |

No MCP servers are required to work on this repo, and none are committed. Add any you want (issue trackers, browsers) in your **user-level** config, not here.

## Skills (Claude Code)

| Skill | Playbook |
| --- | --- |
| `/add-provider` | [playbooks/add-provider.md](playbooks/add-provider.md) |
| `/add-command` | [playbooks/add-command.md](playbooks/add-command.md) |
| `/add-tests` | [playbooks/add-tests.md](playbooks/add-tests.md) |
| `/security-audit` | [playbooks/security-audit.md](playbooks/security-audit.md) |

Other agents: open the playbook and follow it; the skills are only shortcuts.

## Security baseline for agents

- `.claude/settings.json` denies `Read` on `.env*`, `*.pem`, `*.key`, credentials JSON files, project and global `.synapse/config.json`, the telemetry salt, and common cloud credential files. If a task seems to need one of them, stop and ask.
- `.gitignore` covers the same patterns so they aren't committed by accident.
- Never paste keys, tokens or internal links into prompts that end up in commits, PRs or issues. This repo is public.

## Keeping it agent-agnostic

- **Put rules in `AGENTS.md` or `docs/`**, never only in an agent-specific file.
- **`.claude/skills/*` are thin wrappers** around `docs/playbooks/*`. Change the playbook, not the wrapper.
- **Personal settings are never committed:** `CLAUDE.local.md`, `.claude/settings.local.json`, `AGENTS.local.md` (all gitignored).
