# Releasing `@2ndbrainlabs-ai/synapse-cli`

Releases are automated with [release-please](https://github.com/googleapis/release-please)
and published to npm from GitHub Actions with
[provenance](https://docs.npmjs.com/generating-provenance-statements). Nobody
publishes from a laptop.

Relevant files:

| File | Purpose |
| --- | --- |
| `.github/workflows/release.yml` | Runs release-please on every push to `main`; publishes to npm when a release is created |
| `release-please-config.json` | Release type, tag format (`vX.Y.Z`, no component prefix), version-bump rules, changelog sections, extra files to bump. `bootstrap-sha` points at the `v0.1.5` commit because earlier versions have tags but no GitHub Releases; it is only used until the first release-please release exists |
| `.release-please-manifest.json` | The last released version (release-please updates it in each release PR) |
| `CHANGELOG.md` | Generated release notes (release-please writes entries) |

## How a release happens

1. **Conventional Commit PR titles.** Every PR title must follow
   [Conventional Commits](https://www.conventionalcommits.org/) (enforced by the
   `Conventional Commits` workflow), e.g. `feat(cli): add --smart-names flag` or
   `fix(auth): refresh expired tokens`.
2. **Squash merge.** PRs are squash-merged, so the PR title becomes the single
   commit on `main` that release-please reads.
3. **Release PR accumulates changes.** On each push to `main`, release-please
   opens or updates a PR titled `chore(main): release X.Y.Z`. It contains the
   version bump in `package.json`, `package-lock.json`, `config.json` (`version`)
   and `.release-please-manifest.json`, plus the new `CHANGELOG.md` entry.
4. **Review and merge the release PR to cut a release.** Nothing is released
   until a maintainer merges that PR. Merge it when you want to ship.
5. **Tag and GitHub Release.** On that merge, release-please creates the tag
   `vX.Y.Z` and a GitHub Release whose notes are the changelog entry.
6. **npm publish.** The `publish` job (environment `npm`) checks out the tag,
   runs `npm ci` and `npm run ci` (lint, typecheck, tests, build), verifies that
   `package.json` matches the tag, and runs
   `npm publish --provenance --access public`.

### Version bumps

While the package is `0.x`:

| Commit type | Bump |
| --- | --- |
| `fix:`, `perf:`, etc. | patch (`0.1.5` -> `0.1.6`) |
| `feat:` | patch (`bump-patch-for-minor-pre-major`) |
| `feat!:` / `BREAKING CHANGE:` footer | minor (`bump-minor-pre-major`) |

`docs`, `refactor`, `perf`, `revert` and `deps` appear in the changelog;
`build`, `ci`, `chore` and `test` are hidden from it.

## One-time setup (repository owner)

These steps need owner or admin access and are not done by any PR.

1. **npm Trusted Publisher** (preferred, no long-lived token). On npmjs.com,
   open the package `@2ndbrainlabs-ai/synapse-cli` -> Settings -> Trusted
   Publisher -> GitHub Actions, and enter:
   - Organization or user: `2ndbrainlabs-ai`
   - Repository: `synapse-cli-ts`
   - Workflow filename: `release.yml`
   - Environment name: `npm`

   Trusted Publishing requires npm >= 11.5.1; the workflow installs it.
2. **GitHub environment `npm`.** Settings -> Environments -> New environment
   -> `npm`. Optionally add required reviewers so each publish needs approval,
   and restrict deployment to protected branches/tags.
3. **Let Actions open PRs.** Settings -> Actions -> General -> Workflow
   permissions -> enable "Allow GitHub Actions to create and approve pull
   requests". release-please needs this to open the release PR.
4. **Recommended: squash merging only.** Settings -> General -> Pull Requests:
   allow only squash merging, with the default commit message set to
   "Pull request title" (or "Pull request title and description"). Release
   notes then come from the validated PR titles.
5. **Fallback only if Trusted Publishing is not used:** create a granular npm
   access token with publish rights limited to this package, and add it as the
   repository secret `NPM_TOKEN` (Settings -> Secrets and variables -> Actions).
   Enter it only in the GitHub settings UI. Never paste tokens into chat,
   issues, PRs or commits. When `NPM_TOKEN` is unset, the workflow uses OIDC.

Note: pull requests opened by release-please with the default `GITHUB_TOKEN` do
not trigger other workflows (for example CI) on the release PR. That is
acceptable because the publish job runs `npm run ci` itself on the tag.

## Common tasks

### Force a specific version

Add a `Release-As` footer to a commit on `main` (for example in the squash
commit body of a PR):

```
chore: release 0.2.0

Release-As: 0.2.0
```

The next release PR proposes that version.

### Fix the release notes

- Before release: edit the release PR. Changes to `CHANGELOG.md` in the
  release PR branch are kept until the next push to `main` regenerates the PR,
  so prefer the next option for durable fixes.
- Rewrite how a merged commit is recorded: edit the body of the merged PR on
  GitHub and add an override block. release-please reads it on the next run:

  ```
  BEGIN_COMMIT_OVERRIDE
  fix(cli): correct message for one entry
  feat(api): another entry from the same PR
  END_COMMIT_OVERRIDE
  ```

  Overrides are read from the PR body of **squash-merged** PRs only; they have
  no effect for merge commits or rebase merges.
- After release: edit the GitHub Release text and fix `CHANGELOG.md` in a
  normal `docs:` PR.

### Publish failed

The tag and GitHub Release already exist, so do not re-run release-please or
retag. Fix the cause (for example Trusted Publisher configuration or the
`npm` environment) and re-run the failed `publish` job from the Actions run
("Re-run failed jobs"). If the fix needs a code change, ship it as a new
patch release instead.

## First release with this workflow

The commits on `main` since `v0.1.5` were not written as Conventional Commits.
The PR that introduced this workflow (SYN-298) carries a
`BEGIN_COMMIT_OVERRIDE` block in its body that restates them, so the first
release PR proposes `0.1.6` with proper notes. That only takes effect if the
SYN-298 PR is **squash-merged**.
