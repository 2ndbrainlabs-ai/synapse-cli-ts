---
name: add-provider
description: Add a new LLM provider for --local builds: catalog entry, capability flags, adapter only if the API isn't OpenAI-compatible, tests and README docs. Use when asked to support a new model provider or inference host.
---

# add-provider

This skill is a thin wrapper. The procedure lives in a shared, agent-agnostic playbook, so Claude Code, Cursor, Codex and the rest follow the same steps.

1. Read `AGENTS.md` (hard rules) if it isn't already in context.
2. Read and follow `docs/playbooks/add-provider.md` step by step. It links to the reference docs you need.
3. Input from the user: $ARGUMENTS

If this wrapper and the playbook ever disagree, the playbook wins. Fix the procedure in the playbook, not here.
