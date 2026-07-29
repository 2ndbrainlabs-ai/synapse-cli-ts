# Contributing to Synapse CLI

Thanks for your interest in improving Synapse. This document covers the essentials for contributing code, docs, or bug reports.

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an issue with the `bug` label. Include the CLI version (`synapse --version`), your OS, and the `Session:` id printed on failure.
- **Request a feature** — open an issue with the `enhancement` label describing the use case first, not the implementation.
- **Fix an issue** — look for issues tagged `good first issue` or `help wanted`.
- **Improve docs** — README/CONTRIBUTING/inline JSDoc PRs are always welcome.

## Development setup

```bash
git clone https://github.com/2ndbrainlabs-ai/synapse-cli.git
cd synapse-cli
npm install
npm run build
npm test
```

Run the CLI against source instead of the compiled bundle:

```bash
npm run dev -- <command>
```

Point the CLI at a local backend on `localhost:50051` with the `--dev` flag or `SYNAPSE_DEV=1`. See `../synapse-cli-backend/README.md` for backend setup.

## Pull request workflow

1. **Open an issue first** for anything larger than a small fix, so we can align on approach before you invest time.
2. **Branch from `main`** with a descriptive name: `fix/analyze-empty-repo`, `feat/rust-symbols`.
3. **Keep PRs focused.** One logical change per PR. Split refactors from behavior changes.
4. **Add tests.** Every bug fix should include a test that fails without the fix. Every new feature ships with unit or integration coverage.
5. **Pass CI locally** before pushing:

   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

6. **Write clear commit messages** — imperative mood, subject line under 72 chars, body explaining *why* not *what*.
7. **Link the issue** in the PR body with `Closes #123`.

## Coding style

- **TypeScript strict mode** — no `any`, no `@ts-ignore`. Prefer narrow types over generics when it doesn't add value.
- **ESLint + Prettier** — run `npm run lint` before pushing.
- **No new runtime dependencies** without discussion. The install size is a feature.
- **No `console.log`** in shipped code — use the theme helpers in `src/ui/theme.ts` so output stays consistent across TTY and non-TTY.

## AI-assisted contributions

You're welcome to use AI tools while contributing. You are still the author of the PR and responsible for:

- Understanding every line of code you submit.
- Verifying tests actually exercise the change (LLM-generated tests that pass without asserting anything are a common failure mode).
- Not pasting proprietary code from other sources.

## How releases work

Releases are cut by maintainers when a batch of PRs has landed on `main`. The version bump follows [SemVer](https://semver.org). Merged PRs land in the next release without any action on your part.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE) that covers the project.
