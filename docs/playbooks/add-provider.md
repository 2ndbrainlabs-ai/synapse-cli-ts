# Playbook: add an LLM provider for `--local`

Read [../architecture.md](../architecture.md), section "LLM providers", first. Most new providers speak the OpenAI chat-completions API and need **no new adapter**: only a catalog entry, tests and docs.

## Steps

1. **Check it's needed.** Many hosts already work through `custom` (`synapse model set custom --base-url <url>`). A built-in provider is worth adding when it has its own key env var, sensible default models, or a divergence from the OpenAI contract users would otherwise trip over. Open an issue first if you're unsure.
2. **Research the API, from the provider's own docs:** base URL, auth header, key env var name(s), whether `tool_choice` forcing a named function works, the output-cap field (`max_tokens` vs `max_completion_tokens`), whether `temperature` is accepted, any required headers. Note each divergence; it becomes a cap and a test.
3. **Add the id** to the `ProviderId` union in `src/providers/types.ts`.
4. **Add the spec** to `PROVIDERS` in `src/providers/catalog.ts`:
   - `kind`: `"openai-compat"` unless the API is genuinely different.
   - `baseUrl`, `apiKeyEnv` (in priority order), `keyRequired`, `docsUrl`, `label`.
   - `defaults`: a model id per `Task` (`triage` cheap and fast, `generate` / `verify` / `fallback_generate` strong). These are defaults only and are never validated client-side; don't add an allowlist.
   - `caps`: start from the OpenAI-compatible caps and change only what step 2 showed.
   - `headers` / `note` only if needed.
5. **Only if the API isn't OpenAI-compatible:** add a new `ProviderKind`, an adapter in `src/providers/<name>.ts` that implements `LlmProvider` (one forced tool call → parsed JSON, `LlmError` for failures with the right retryable classification), and a branch in `createProvider()` (`src/providers/index.ts`). Keep capability handling inside the adapter. Cloud providers with their own credential chain follow `bedrock.ts` / `vertex.ts` and `CloudSpec`. Don't add a runtime dependency without an issue first.
6. **Config and CLI:** `PROVIDER_IDS` feeds `llm-config.ts` validation and `synapse model list / set` automatically. Check `src/commands/model.ts` and `src/config/llm-config.ts` for provider-specific branches (flags that apply only to some providers) and extend them if your provider needs one.
7. **Tests** (see [../testing.md](../testing.md)):
   - Add the id to the catalog invariant list in `tests/unit/providers/provider-divergence.test.ts`.
   - Add it to the relevant `it.each` blocks there, and assert the exact request for each divergence from step 2.
   - New adapter: a test file in `tests/unit/providers/` against a local `http.createServer` (or a mocked SDK), covering a tool-call reply, a JSON-content reply, a 429 and a 5xx.
   - `tests/unit/config/llm-config.test.ts`: key resolution from the new env var(s) and `SYNAPSE_LLM_API_KEY` fallback.
   - Use fake keys only.
8. **Docs:** in `README.md`, add a row to "Choosing a provider", "Providing your API key", a copy-paste quickstart, and "Provider differences" if there's a divergence. Update the provider list in [CONTEXT.md](../../CONTEXT.md).
9. **Verify:** `npm run ci`. If you have a key, run one real `--local` build against a small project (see [../development.md](../development.md)) and say in the PR which model you used. Never paste the key into the PR.

## PR

Title: `feat(providers): add <name> provider for --local builds`. Say which divergences you found and how they're handled.
