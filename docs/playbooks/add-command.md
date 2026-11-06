# Playbook: add or change a CLI command or flag

Read [../architecture.md](../architecture.md) ("Entry and build", "Commands") first.

## Steps

1. **Agree on the interface first** for anything user-visible: name, arguments, flags, defaults, exit codes, and how it behaves without a TTY. Commands and flags are public API; renaming one later is a breaking change (`feat!:`).
2. **Register it in `src/index.ts`** with commander:
   - `.command("<name> [arg]")`, `.description(...)`, `.option(...)`.
   - The `.action()` lazy-imports the handler: `const { runX } = await import("./commands/x.js");`. Don't import command modules at the top of `index.ts`; it slows every invocation.
   - Subcommands follow the `model` / `config` pattern (`program.command("model")` then `.command("set <provider>")` on it).
   - Global flags (`--yes`, `--dev`) are read with `cmd.optsWithGlobals()`.
3. **Write the handler** in `src/commands/<name>.ts` (or `src/commands/v2/` for build-engine work) as an exported `async function runX(opts)` with a typed options object.
   - Print through `src/ui/` (`t` and `stepInfo` / `stepWarn` / `sectionHeader` from `theme.ts`, `roundedBox` from `box.ts`; `sectionBox` is deprecated), not raw `console.log` with escape codes.
   - Ask questions only through `src/ui/prompt.ts`, and check `canPrompt()`: with `--yes` or no TTY, use a default or fail with a clear message telling the user which flag to pass.
   - Signal failure with `process.exitCode = 1` (or the build outcome codes in `src/commands/v2/build-outcome.ts`); let `index.ts` handle exit.
   - Config goes through `src/config/manager.ts` and paths through `src/config/paths.ts`; never hard-code `~/.synapse`.
   - Network calls go through the existing clients (`src/grpc/`, `src/config/api-keys-client.ts`). Never print or send a key except to the service it belongs to (see [../security.md](../security.md)).
4. **Telemetry:** if the command should emit an event, use `trackEvent` in `src/grpc/telemetry.ts`, keep it metadata-only, and make sure `SYNAPSE_TELEMETRY=0` suppresses it. If it sends anything new, update the README table "What leaves your machine".
5. **Tests** in `tests/unit/commands/<name>.test.ts` ([../testing.md](../testing.md)): mock `src/ui/prompt.js` and the network client, redirect config paths, and cover the happy path, the non-interactive path, invalid input, and a network failure. Assert on exit code, written config and printed output (keys redacted).
6. **Docs:** add or update the row in the README "Commands" table, and any section the flag changes. Add new terms to [CONTEXT.md](../../CONTEXT.md).
7. **Verify:** `npm run ci`, then `npm run build && node dist/index.js <name> --help` and one real run in a scratch directory.

## PR

Title: `feat(cli): add synapse <name>` (or `fix(cli): …`). Show the `--help` output and a sample run in the description.
