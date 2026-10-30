// REST client behind `synapse config keys|revoke` (SYN-182). fetch is stubbed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  ApiKeysError,
  findKeyInUse,
  listApiKeys,
  revokeApiKey,
  signedKeyId,
  type ApiKeyInfo,
} from "../../../src/config/api-keys-client.js";

function signed(claims: Record<string, unknown>): string {
  const pl = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `syn_live_v1.${pl}.c2ln`;
}

function key(id: string, keyPrefix: string): ApiKeyInfo {
  return { id, keyPrefix, name: id, createdAt: null, lastUsed: null, expiresAt: null };
}

describe("signedKeyId", () => {
  it("reads api_key_id from a signed key's payload", () => {
    expect(signedKeyId(signed({ v: 1, api_key_id: "abc-123", jti: "j" }))).toBe("abc-123");
  });

  it("is null for legacy and malformed keys", () => {
    expect(signedKeyId("syn-api-abcdefghij0123456789")).toBeNull();
    expect(signedKeyId("syn_live_v1.notjson.sig")).toBeNull();
    expect(signedKeyId("syn_live_v1.onlytwo")).toBeNull();
    expect(signedKeyId(signed({ v: 1 }))).toBeNull();
  });
});

describe("findKeyInUse", () => {
  const keys = [
    key("k-legacy", "syn-api-abcdefghij"),
    key("k-other", "syn-api-zzzzzzzzzz"),
    key("k-signed", "syn_live_v1.eyJ2Ijox"),
  ];

  it("matches a signed key by its embedded id", () => {
    expect(findKeyInUse(signed({ api_key_id: "k-signed" }), keys)?.id).toBe("k-signed");
  });

  it("does not guess a signed key by prefix", () => {
    // Every signed key shares its first 20 characters.
    expect(findKeyInUse(signed({ api_key_id: "unknown" }), keys)).toBeNull();
  });

  it("matches a legacy key by its stored prefix", () => {
    expect(findKeyInUse("syn-api-abcdefghijREST", keys)?.id).toBe("k-legacy");
    expect(findKeyInUse("syn-api-nomatch000000", keys)).toBeNull();
  });
});

describe("listApiKeys / revokeApiKey", () => {
  const savedUrl = process.env.SYNAPSE_API_URL;
  let calls: Array<{ url: string; method: string; auth: string }>;

  function stub(response: Response | Error): void {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        calls.push({ url: String(url), method: String(init.method), auth: headers.Authorization });
        if (response instanceof Error) throw response;
        return response;
      }),
    );
  }

  beforeEach(() => {
    process.env.SYNAPSE_API_URL = "https://api.example.test/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedUrl === undefined) delete process.env.SYNAPSE_API_URL;
    else process.env.SYNAPSE_API_URL = savedUrl;
  });

  it("lists keys with the bearer key and maps the fields", async () => {
    stub(
      new Response(
        JSON.stringify({
          api_keys: [
            {
              id: "k1",
              key_prefix: "syn-api-abcdefghij",
              name: "laptop",
              created_at: "2026-10-01T00:00:00",
              last_used: null,
              expires_at: null,
              is_active: true,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const keys = await listApiKeys("syn-api-secret");
    expect(calls[0]).toEqual({
      url: "https://api.example.test/api-keys",
      method: "GET",
      auth: "Bearer syn-api-secret",
    });
    expect(keys).toEqual([
      {
        id: "k1",
        keyPrefix: "syn-api-abcdefghij",
        name: "laptop",
        createdAt: "2026-10-01T00:00:00",
        lastUsed: null,
        expiresAt: null,
      },
    ]);
  });

  it("revokes with DELETE /api-keys/{id}", async () => {
    stub(new Response(JSON.stringify({ message: "ok" }), { status: 200 }));
    await revokeApiKey("syn-api-secret", "k1");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.example.test/api-keys/k1");
  });

  it("maps a 401 to a rejected-key error", async () => {
    stub(new Response("", { status: 401 }));
    await expect(listApiKeys("bad")).rejects.toMatchObject({ status: 401 });
  });

  it("surfaces the API's 404 detail", async () => {
    stub(new Response(JSON.stringify({ detail: "API key not found or unauthorized" }), { status: 404 }));
    await expect(revokeApiKey("k", "missing")).rejects.toThrow(/not found/);
  });

  it("reports an unreachable API as status 0", async () => {
    stub(new TypeError("fetch failed"));
    const err = await listApiKeys("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiKeysError);
    expect((err as ApiKeysError).status).toBe(0);
  });
});
