# Playbook: add tests

Read [../testing.md](../testing.md) first: it explains isolation, mocking patterns and what not to touch.

## Steps

1. **Pick the target** and read it. Find the existing test file for that module under `tests/unit/<area>/` (the layout mirrors `src/`); extend it rather than creating a parallel one.
2. **List the cases before writing code:**
   - the happy path
   - each branch that changes output, exit code or what is written to disk
   - invalid input and missing config
   - dependency failure (network error, 4xx / 5xx, malformed response) → the documented behaviour, not a stack trace
   - non-interactive mode (`--yes` / no TTY) for anything that prompts
   - for anything that sends or prints data: no keys, prompts or source code where they shouldn't be
3. **Isolate:** rely on `tests/setup/isolated-home.ts` for `HOME`; mock `src/config/paths.js` when you need a known global dir; stub env vars and restore them; mock `src/ui/prompt.js` for prompts; use a local `http.createServer` or `vi.mock` for network. No real services, no real keys.
4. **Name tests after behaviour**, using [CONTEXT.md](../../CONTEXT.md) terms: `"falls back to JSON mode when the provider has no tool_choice"`, not `"test 2"`.
5. **Bug fixes:** write the test first and watch it fail for the right reason, then fix.
6. **Run:** `npx vitest run <file>`, then `npm run typecheck:tests` (vitest doesn't typecheck), then `npm run ci`.
7. **Check the tests can fail:** temporarily break the code under test (or invert an assertion) and confirm the new test goes red. Undo it.

## Don't

- Call the hosted backend, the REST API or a real model provider.
- Use real credentials, even expired ones.
- Depend on test order, the clock, or the developer's hostname, username or files in `~`.
- Snapshot large terminal output; assert on the lines that matter.
