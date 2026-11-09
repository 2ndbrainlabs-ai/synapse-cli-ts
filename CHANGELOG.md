# Changelog

## [0.1.9](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/compare/v0.1.8...v0.1.9) (2026-11-09)


### ⚠ BREAKING CHANGES

* **cli:** remove the legacy v1 engine and orphaned src/builder code (SYN-257) ([#43](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/43))
* require node 20+ and harden the repo for open source (SYN-302) ([#42](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/42))

### Features

* **build:** reuse discovered endpoints unless --discover is passed (SYN-8) ([#44](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/44)) ([dbedc54](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/dbedc5454ccbaf9be86a69c3c4cbc5417ad48226))
* **cli:** remove the legacy v1 engine and orphaned src/builder code (SYN-257) ([#43](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/43)) ([338354d](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/338354da3739430ec7b623e6e65b0b4527b3189f))
* require node 20+ and harden the repo for open source (SYN-302) ([#42](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/42)) ([9a3f306](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/9a3f306ea2231f52e48301f7d781786a0b47799c))


### Documentation

* add agent setup for contributors (SYN-293) ([#54](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/54)) ([f66d961](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/f66d96117db3017ef3cf6e39636d51325dc3c199))

## [0.1.8](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/compare/v0.1.7...v0.1.8) (2026-11-02)


### Bug Fixes

* **build:** check custom-mode language before charging lines (SYN-366) ([#52](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/52)) ([92ac67b](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/92ac67b55f0c5c0c478b617aeb6af47709554edc))
* **build:** detect Go repos as Go and extract their routes (SYN-353) ([#49](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/49)) ([f66b5ed](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/f66b5ede9c17263838ac3be1e7cc2186d6b9c612))
* **telemetry:** add session_id and CLI version, salt hashed ids; installation_id changes once on upgrade (SYN-367) ([#53](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/53)) ([4a7bdea](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/4a7bdea549b73a0231fadf48e81b986ef106d9b7))
* **telemetry:** send failure build events before exit (SYN-365) ([#51](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/51)) ([876f191](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/876f19190a7eb6ef436ebd3a06581388abf93ca7))

## [0.1.7](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/compare/v0.1.6...v0.1.7) (2026-11-01)


### Bug Fixes

* **analyze:** count non-Python source files and lines (SYN-274) ([#47](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/47)) ([47b18d8](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/47b18d89220c6bd00776ba7497dcfb4339157769))

## [0.1.6](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/compare/v0.1.5...v0.1.6) (2026-10-30)


### Features

* **config:** switch default endpoints to 2ndbrainlabs.ai (SYN-254) ([#19](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/19)) ([c103ba6](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/c103ba6a967e49f11de04a782267d1a61c1310b4))
* **config:** verify and rotate API keys, list and revoke account keys (SYN-182) ([#32](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/32)) ([22e6990](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/22e6990be2b756489b7ee7f727e463a24ac5e12b))
* **providers:** add Amazon Bedrock and Google Vertex AI providers for local mode (SYN-73) ([c8a1a50](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/c8a1a50c24cee764ebc753016ce2a41ce83b1393))
* **telemetry:** send the CLI version with telemetry events (SYN-273) ([#24](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/24)) ([1efbe7e](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/1efbe7e5f06523c0a47acb6d08cd9798840899ef))


### Bug Fixes

* **build:** exit non-zero on failed builds and report accurate errors (SYN-314) ([#27](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/27)) ([003405a](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/003405a76bb025f374d20a2d0b9d3f13d137184b))
* **build:** reuse the project's MCP server on rebuild instead of creating a new one (SYN-285) ([#31](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/31)) ([827e6c3](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/827e6c3a3a882b7101dff05ab7ed73aa2a2949a7))
* **cli:** verify keys through a cold start, unique session ids, init/analyze outcome telemetry (SYN-321) ([#28](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/28)) ([4a3ceeb](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/4a3ceeb054fecd761897ea2d1bf321272d013fe8))
* **deps:** resolve high and critical npm audit findings ([c8a1a50](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/c8a1a50c24cee764ebc753016ce2a41ce83b1393))
* **deps:** upgrade zod to v4 to clear high-severity advisory (SYN-306) ([#25](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/25)) ([adf37a7](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/adf37a784064b9c410659864b747e26aa403ec2a))
* **grpc:** don't retry quota rejections on RESOURCE_EXHAUSTED (SYN-317) ([#29](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/29)) ([9b5fd0f](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/9b5fd0f4e9affa0b55a78b05399db1a1a6bbe643))
* **quota:** charge indexed lines once across analyze and builds (SYN-315) ([#30](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/30)) ([a67695d](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/a67695dbe7a05f14cec18c22c652b9974160fffb))
* **quota:** count indexed lines in v2 hosted builds and enforce the lines quota (SYN-315) ([#26](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/26)) ([93c56bc](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/93c56bcf61d7b5d92c3d00dd3eb151a793c43dbf))


### Documentation

* new Synapse logo and synapse.2ndbrainlabs.ai branding ([#46](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/46)) ([d6c5630](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/d6c5630b4725c8d6216c1beb089505dc5d46d15e))
* **readme:** correct build modes, languages, output and privacy claims (SYN-184) ([#23](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/issues/23)) ([66584f5](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/66584f50d0b13f697c42d808b9c3a98ee62bbbec))


### Code Refactoring

* remove the unused query expander that called /telemetry/rerank (SYN-183) ([c8a1a50](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/commit/c8a1a50c24cee764ebc753016ce2a41ce83b1393))

## Changelog

All notable changes to `@2ndbrainlabs-ai/synapse-cli` are documented here.
Entries are generated by [release-please](https://github.com/googleapis/release-please)
from Conventional Commit messages; see [docs/RELEASING.md](docs/RELEASING.md).

Releases before 0.1.6 are not listed here; see the
[GitHub tags](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/tags) and the
[npm version history](https://www.npmjs.com/package/@2ndbrainlabs-ai/synapse-cli?activeTab=versions).
