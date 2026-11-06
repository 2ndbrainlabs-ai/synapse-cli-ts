# Testing

The suite is [vitest](https://vitest.dev). Tests live in `tests/` and mirror `src/`.

## Run

```bash
npm test                                             # everything (vitest run)
npm run test:watch                                   # watch mode
npx vitest run tests/unit/providers/openai-compat.test.ts   # one file
npx vitest run -t "drops temperature"                # tests whose name matches
npm run typecheck:tests                              # typecheck the tests too
```

CI runs `npm test` and `npm run typecheck:tests` on every PR. `npm run ci` runs both locally, plus lint and build.

## Layout

| Path | What goes there |
| --- | --- |
| `tests/unit/<area>/` | Unit tests, one folder per `src/` area (`backend`, `commands`, `config`, `extractors`, `grpc`, `providers`, `session`, `ui`, `utils`, ...) |
| `tests/integration/` | Tests that run several modules together (e.g. the local provider pipeline end to end against a fake model server) |
| `tests/fixtures/` | Sample source trees for extractor tests (`multi-lang-apis/<language>/`) |
| `tests/setup/isolated-home.ts` | Runs before every test file (`vitest.config.ts` `setupFiles`) |

Name test files `<thing>.test.ts`. Contract tests use `<thing>.contract.test.ts`.

## Isolation: nothing touches the real machine

- **`HOME` is redirected.** `tests/setup/isolated-home.ts` points `HOME` / `USERPROFILE` at a temp dir before each file, so code that writes to `~/.synapse` (config, telemetry salt) never touches a real config. Tests that need a known global dir also mock `src/config/paths.js` (see `tests/unit/commands/config.test.ts`).
- **No real network.** Never call the hosted backend, the REST API or a real model provider.
  - For HTTP providers, prefer a throwaway local `http.createServer` and assert on the request it receives (see `tests/unit/providers/openai-compat.test.ts`). That tests wire behaviour, not a mock.
  - For SDK-based providers and the REST client, mock the module or `fetch` with `vi.mock` / `vi.stubGlobal`.
- **No real credentials.** Use obvious fakes (`sk-test-123`, `syn_test_…`). Never paste a real key, even an expired one.
- **Environment variables:** set them in the test and restore them in `afterEach` (or use `vi.stubEnv` and `vi.unstubAllEnvs`). Keys like `ANTHROPIC_API_KEY` or `SYNAPSE_API_KEY` in your shell must not change test results.
- **Prompts:** mock `src/ui/prompt.js` (`canPrompt`, `askSecret`, `askConfirm`) instead of driving a TTY.

## Mocking patterns

- `vi.mock(path, async (importOriginal) => ({ ...(await importOriginal()), fn: ... }))` to replace one export and keep the rest.
- `vi.hoisted(() => ({ ... }))` for state a mock factory needs (mock factories are hoisted above imports).
- Import the module under test **after** the mocks with a top-level `await import(...)` when the mock must be in place at import time.
- Import source with `.js` extensions: `../../../src/config/manager.js`.

## What to test

- **Bug fixes:** a test that fails without the fix. Check it does by reverting the fix locally.
- **Providers:** the exact request each provider receives (fields, headers, `tool_choice` vs JSON-mode fallback, `max_tokens` field name) and response parsing for both tool-call and JSON-content replies. Add new providers to `tests/unit/providers/provider-divergence.test.ts`.
- **Commands:** exit codes, what is written to config, and what is printed (redacted keys only).
- **Extractors:** add a fixture under `tests/fixtures/` and assert on the manifest.
- **Wire contracts:** if you change `manifest-wire.ts`, the contract test must still pass against `protos/wire-manifest.schema.json`.
- **Privacy:** anything that sends data out asserts on the payload, including that no key, prompt or source code is in it when it shouldn't be.

## Don't

- Write tests that pass without asserting anything (a common failure mode of generated tests). Run `typecheck:tests` and read the assertions.
- Depend on test order, wall-clock time or the developer's machine (hostname, username, files in `~`).
- Add a second test framework.
