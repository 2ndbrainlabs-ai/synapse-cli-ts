# Development

## Setup

```bash
git clone https://github.com/2ndbrainlabs-ai/synapse-cli-ts.git
cd synapse-cli-ts
npm ci --legacy-peer-deps     # what CI runs; plain `npm install` also works
npm run build
npm test
```

Use the Node version CI uses (see `.github/workflows/ci.yml`) and the one allowed by `engines` in `package.json`. tree-sitter has native bindings, so a Node version change means reinstalling `node_modules`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev -- <command> [flags]` | Run the CLI from source with tsx, e.g. `npm run dev -- build --local --auto` |
| `npm run build` | tsup → `dist/index.js` (CLI) and `dist/parse-worker.js` (worker thread) |
| `npm start -- <command>` | Run the built CLI |
| `npm run lint` | ESLint over `src/` and `tests/`. Must report 0 errors (existing `any` warnings are tolerated, don't add new ones) |
| `npm run typecheck` | `tsc --noEmit` on `src/` (`tsconfig.json` excludes `tests/`) |
| `npm run typecheck:tests` | Typecheck `src/` and `tests/` together (`tsconfig.test.json`) |
| `npm test` / `npm run test:watch` | vitest, once / in watch mode |
| `npm run ci` | lint + typecheck + typecheck:tests + test + build: the same gates as CI |
| `npm audit --audit-level=high` | The CI dependency audit |
| `npm pack --dry-run` | What would be published. Run it when you touch `package.json` `files`, `.npmignore` or add files at the root |

## Running against a real project

```bash
cd /path/to/some/api-project
node /path/to/synapse-cli-ts/dist/index.js build --local --auto   # after npm run build
```

- `--local` uses your own model provider (see the README, "Run locally with your own model"). Auto mode without `--smart-names` calls no model at all, which makes it the cheapest end-to-end check.
- Hosted builds need a Synapse API key (`SYNAPSE_API_KEY` or `synapse config set-key`) and count against your quota.
- `--dev` / `SYNAPSE_DEV=1` points at a backend on `localhost:50051`. That's for maintainers who run the backend locally.
- `docs/LOCAL_MODE_VERIFICATION.md` is the manual pre-release checklist for `--local`.

## Gotchas

- **Test types aren't checked by `npm test`.** esbuild strips types, so a test calling a renamed option can pass while asserting nothing. Run `npm run typecheck:tests` (CI does).
- **Imports use `.js` extensions** in both `src/` and `tests/` (Node16 module resolution).
- **The CLI loads `.env` from the current directory** at startup. When you run it inside your own project, that project's `.env` is in `process.env`.
- **`test-apis.ts`** at the repo root is an ad-hoc script, not part of the suite. Real fixtures are in `tests/fixtures/multi-lang-apis/`.

## Releasing

You don't release anything by hand. PR titles drive release-please; see [RELEASING.md](RELEASING.md).
