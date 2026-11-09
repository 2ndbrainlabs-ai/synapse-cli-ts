# Domain docs

How agents (and people) should use this repo's domain documentation.

## Before exploring, read these

- **[CONTEXT.md](../../CONTEXT.md)** at the repo root: the glossary.
- **`docs/adr/`**: architecture decision records that touch the area you're working in. The folder is created with the first ADR; if it doesn't exist yet, carry on and don't create it upfront.
- **[architecture.md](../architecture.md)**: how the modules fit together.

## Use the glossary's vocabulary

When you name a domain concept (in an issue title, a function, a test name or a PR), use the term from `CONTEXT.md`, not a synonym. If a concept you need is missing, either you're inventing language the project doesn't use (reconsider), or there's a real gap: add it to `CONTEXT.md` in the same PR.

## Record decisions as ADRs

When a PR makes a decision someone will later ask "why?" about (a new provider kind, a change to what leaves the user's machine, dropping a dependency, a wire-format change), add `docs/adr/NNNN-short-title.md` with: context, decision, consequences. Keep it under a page.

## Flag ADR conflicts

If your change contradicts an existing ADR, say so explicitly in the PR rather than silently overriding it:

> _Contradicts ADR-0002 (…), but worth reopening because…_
