---
name: add-tests
description: Add vitest tests with an isolated HOME, mocked prompts and no real network or keys. Use when asked to add tests, cover a bug with a test, or improve coverage.
---

# add-tests

This skill is a thin wrapper. The procedure lives in a shared, agent-agnostic playbook, so Claude Code, Cursor, Codex and the rest follow the same steps.

1. Read `AGENTS.md` (hard rules) if it isn't already in context.
2. Read and follow `docs/playbooks/add-tests.md` step by step. It links to the reference docs you need.
3. Input from the user: $ARGUMENTS

If this wrapper and the playbook ever disagree, the playbook wins. Fix the procedure in the playbook, not here.
