---
name: add-command
description: Add or change a synapse CLI command or flag: commander registration with a lazy-imported handler, src/ui output, non-interactive behaviour, tests and README. Use when asked to add, rename or change a command, subcommand or flag.
---

# add-command

This skill is a thin wrapper. The procedure lives in a shared, agent-agnostic playbook, so Claude Code, Cursor, Codex and the rest follow the same steps.

1. Read `AGENTS.md` (hard rules) if it isn't already in context.
2. Read and follow `docs/playbooks/add-command.md` step by step. It links to the reference docs you need.
3. Input from the user: $ARGUMENTS

If this wrapper and the playbook ever disagree, the playbook wins. Fix the procedure in the playbook, not here.
