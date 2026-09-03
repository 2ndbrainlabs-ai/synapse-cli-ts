# Local-mode verification runbook

Checks to run before publishing a release that includes `--local`. Corresponds to the "Verification" section of the design plan at `~/.claude/plans/snappy-hugging-wall.md`.

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-…    # a real key, not test-…
npm run build
alias synapse=/absolute/path/to/dist/index.js
```

Pick 5 test repos (FastAPI-shaped, ≥50 public functions each). Suggested: any of your own FastAPI projects, `tiangolo/fastapi` examples, `full-stack-fastapi-template`.

## Checks

1. **Hosted mode unchanged.** In a project init'd normally (no `--local`), `synapse build` still hits `grpc.synaps3.ai`. Regression tests pass unchanged: `npm test`.

2. **`--local` is per-invocation.** `synapse init --local` is *not* a thing — it exits non-zero with `unknown option '--local'`. No project config pins a repo to local mode; `resolveEffectiveMode` reads the build flag only. Confirm `.synapse/config.json` never gains a `"mode": "local"` key.

3. **Missing key is refused before work starts.** `env -u ANTHROPIC_API_KEY synapse build --local` → red "Anthropic not ready" box naming `ANTHROPIC_API_KEY`, no extraction run, no config written.

4. **One-shot build.** In a fresh empty repo (no `synapse init`), `synapse build --local --llm-api-key sk-…` works end-to-end. `.synapse/` is not created. The deprecated `--anthropic-key` alias must still work identically.

5. **`build` in `--local`-init'd project.** Picks up `ANTHROPIC_API_KEY` from env, runs codegen in-process, writes `mcp_server.py`. Validate with `python -c "import ast; ast.parse(open('mcp_server.py').read())"`.

6. **Flag beats env.** `ANTHROPIC_API_KEY=bogus synapse build --local --llm-api-key sk-ant-real` succeeds — flag wins over env. Same with the legacy `--anthropic-key`.

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

## Multi-provider checks

Local mode drives Anthropic natively and everything else through one
OpenAI-compatible adapter, so the risk is concentrated in that adapter and in
config resolution. `tests/unit/providers/`, `tests/unit/config/` and
`tests/integration/local-provider-pipeline.test.ts` cover the wire contract
against a real HTTP server; these are the manual checks that need live keys.

16. **Each hosted provider generates a working server.** For `openai`, `groq`,
    `grok`, `openrouter`: export the provider's key, `synapse model set <id>`,
    then `synapse build --local --custom -q "…"`. Each must produce a file that
    passes `python -c "import ast; ast.parse(open(...).read())"`.

17. **Ollama, no key.** `ollama pull qwen3-coder:30b`, `synapse model set ollama`,
    build. Verify from `synapse model` that it reports the JSON-mode path
    ("Endpoint ignores tool_choice"), and that no `Authorization` header is sent
    (mitmproxy). A too-small model should fail with the "no emit_tool_plan call"
    message naming `synapse model set`, not a stack trace.

18. **OpenAI parameter divergence.** With a reasoning model (e.g. `gpt-5`),
    confirm via mitmproxy that the request carries `max_completion_tokens` and
    **no** `temperature`. Sending `max_tokens` there is a 400.

19. **Custom endpoint.** Point `--base-url` at a local vLLM/LM Studio server.
    Verify `--no-tool-choice`, `--max-completion-tokens` and `--no-temperature`
    each change the outgoing body as declared.

20. **Key never persisted by default.** After builds on every provider:
    `grep -rE "sk-|gsk_|xai-" ~/.synapse ./.synapse` returns nothing. Then
    `synapse model set groq --save-key gsk_…` and confirm the config holds only
    a 5-char prefix plus `gAAAAAB…` ciphertext — never the raw key.

21. **Stored key is machine-bound.** Copy a `--save-key` config to another host
    (or change hostname). `synapse model` must warn that it cannot decrypt and
    tell the user to re-enter, not fail silently or crash.

22. **Provider switch does not inherit models.** `synapse model set groq --model X`
    then `synapse build --local --provider openai` — the request must use
    OpenAI's default model, not `X`.

## Sign-off

Only cut the release when all checks pass. If #12 shows drift you can't explain, hold — the shape of the local pipeline should match hosted output for the `custom_build` track.
