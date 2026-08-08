# Local-mode verification runbook

15 checks to run before publishing a release that includes `--local`. Corresponds to the "Verification" section of the design plan at `~/.claude/plans/snappy-hugging-wall.md`.

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-…    # a real key, not test-…
npm run build
alias synapse=/absolute/path/to/dist/index.js
```

Pick 5 test repos (FastAPI-shaped, ≥50 public functions each). Suggested: any of your own FastAPI projects, `tiangolo/fastapi` examples, `full-stack-fastapi-template`.

## Checks

1. **Hosted mode unchanged.** In a project init'd normally (no `--local`), `synapse build` still hits `grpc.synaps3.ai`. Regression tests pass unchanged: `npm test`.

2. **`init --local` with env set.** `ANTHROPIC_API_KEY=sk-… synapse init --local` → exits 0, `.synapse/config.json` contains `"mode": "local"`, no Anthropic key on disk (`grep -r sk-ant .synapse` returns nothing).

3. **`init --local` without env.** `env -u ANTHROPIC_API_KEY synapse init --local` → non-zero exit, red "Anthropic API key required" box, no config written.

4. **One-shot build.** In a fresh empty repo (no `synapse init`), `synapse build --local --anthropic-key sk-…` works end-to-end. `.synapse/` is not created.

5. **`build` in `--local`-init'd project.** Picks up `ANTHROPIC_API_KEY` from env, runs codegen in-process, writes `mcp_server.py`. Validate with `python -c "import ast; ast.parse(open('mcp_server.py').read())"`.

6. **`--anthropic-key` override.** `ANTHROPIC_API_KEY=bogus synapse build --local --anthropic-key sk-ant-real` succeeds — flag wins over env.

7. **No key on disk, ever.** After any `--local` run: `grep -r "sk-ant" ~/.synapse ./.synapse` returns nothing.

8. **LLM trace forwarding.** Run with mitmproxy pointed at `api.synaps3.ai`. See one `POST /telemetry/llm-trace` per Anthropic call. Payload contains no prompt bodies or generated code — just tokens, hashes, timings.

9. **Telemetry opt-out.** `SYNAPSE_TELEMETRY=0 synapse build --local` → zero outbound requests to `synaps3.ai`.

10. **User's Anthropic quota.** After 3 local builds, the user's Anthropic dashboard shows the requests. Our infra shows nothing under their user_id.

11. **Auto refusal.** `synapse build --local --auto` prints the friendly error, exits non-zero, zero Anthropic calls made.

12. **Regression corpus (the actual 5 repos).** For each repo, run:
    ```bash
    synapse build           # hosted, save output as hosted_mcp_server.py
    synapse build --local   # local, save as local_mcp_server.py
    ```
    Diff: tool names should match, schemas should match, both files pass `python -c "import ast; ast.parse(open(...).read())"`. Small prose differences in `description` are OK.

13. **Quota exemption — local build.** Generate 20 MCP servers in `--local` on the same account. `synapse info` shows hosted `mcp_servers_count` unchanged. ui-backend logs show 20 `local_usage_build.local` events under `installation_id`.

14. **Quota exemption — analyze.** `synapse analyze` in a `--local`-init'd project against a 1M-LOC repo. No `lines_indexed` increment. Same repo in hosted mode DOES increment and hits the limit.

15. **Hosted quota unchanged.** Hosted-mode build still increments `mcp_servers_count` and enforces `max_mcp_servers` at the same threshold as before.

## Sign-off

Only cut the release when all 15 pass. If #12 shows drift you can't explain, hold — the shape of the local pipeline should match hosted output for the `custom_build` track.
