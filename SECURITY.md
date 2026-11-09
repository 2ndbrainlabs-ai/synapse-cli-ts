# Security Policy

We take security seriously. Thank you for helping keep Synapse and its users safe.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately instead:

1. **Preferred: GitHub private vulnerability reporting.** Open a draft advisory at **[Report a vulnerability](https://github.com/2ndbrainlabs-ai/synapse-cli-ts/security/advisories/new)** (also reachable from the repository's **Security** tab). Only you and the maintainers can see it.
2. **Fallback: email [security@2ndbrainlabs.ai](mailto:security@2ndbrainlabs.ai)** if you cannot use GitHub's private reporting.

Please include, where you can:

- the affected version (`synapse --version`) and your OS and Node.js version,
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any suggested fix or mitigation.

We aim to acknowledge reports within 72 hours, keep you updated while we investigate, and credit you in the advisory once a fix is released (unless you prefer to stay anonymous). Please give us a reasonable chance to fix the issue before disclosing it publicly.

## Supported Versions

Only the latest published release of `@2ndbrainlabs-ai/synapse-cli` on npm receives security fixes.

| Version         | Supported |
| --------------- | --------- |
| Latest release  | Yes       |
| Older releases  | No        |

## Scope

This policy covers the `@2ndbrainlabs-ai/synapse-cli` npm package and its source in this repository. Generated MCP server files are user-owned and out of scope — audit them before running.
