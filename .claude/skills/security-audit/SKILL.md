---
name: security-audit
description: Security review of a diff or the whole repo: committed secrets, npm package contents, key storage, keys in output or sent to the wrong host, telemetry payloads, command execution, CI. Findings are reported privately because the repo is public. Use when asked for a security review or audit.
---

# security-audit

This skill is a thin wrapper. The procedure lives in a shared, agent-agnostic playbook, so Claude Code, Cursor, Codex and the rest follow the same steps.

1. Read `AGENTS.md` (hard rules) if it isn't already in context.
2. Read and follow `docs/playbooks/security-audit.md` step by step. It links to the reference docs you need.
3. Input from the user: $ARGUMENTS

If this wrapper and the playbook ever disagree, the playbook wins. Fix the procedure in the playbook, not here.
