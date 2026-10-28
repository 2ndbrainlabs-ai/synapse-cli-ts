// CLI telemetry events carry the CLI version (SYN-273).
//
// trackEvent() adds cli_version to the /telemetry/cli payload when the
// version is known, leaves it out when it falls back to "0.0.0", and stays
// fire-and-forget either way.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const versionState = vi.hoisted(() => ({ override: null as string | null }));

vi.mock("../../../src/utils/version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/utils/version.js")>();
  return {
    ...actual,
    readCliVersion: () => versionState.override ?? actual.readCliVersion(),
  };
});

import { trackEvent, verifyApiKey } from "../../../src/grpc/telemetry.js";
import { readCliVersion } from "../../../src/utils/version.js";

const PKG_VERSION = (
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8"),
  ) as { version: string }
).version;

describe("trackEvent cli_version", () => {
  const saved = {
    api: process.env.SYNAPSE_API_URL,
    telemetry: process.env.SYNAPSE_TELEMETRY,
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  function sentBody(): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/telemetry/cli");
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  beforeEach(() => {
    process.env.SYNAPSE_API_URL = "https://api.example.test";
    delete process.env.SYNAPSE_TELEMETRY;
    versionState.override = null;
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved.api === undefined) delete process.env.SYNAPSE_API_URL;
    else process.env.SYNAPSE_API_URL = saved.api;
    if (saved.telemetry === undefined) delete process.env.SYNAPSE_TELEMETRY;
    else process.env.SYNAPSE_TELEMETRY = saved.telemetry;
  });

  it("reads the version from package.json", () => {
    expect(readCliVersion()).toBe(PKG_VERSION);
  });

  it("includes cli_version in a hosted event", async () => {
    await trackEvent("build", "syn_key", "/tmp/project", 0, 3);
    const body = sentBody();
    expect(body.cli_version).toBe(PKG_VERSION);
    expect(body.event_type).toBe("build");
    expect(body.tool_count).toBe(3);
  });

  it("includes cli_version in a local event", async () => {
    await trackEvent("build.local", "", "/tmp/project", 0, 0, 0, 0, "local");
    const body = sentBody();
    expect(body.cli_version).toBe(PKG_VERSION);
    expect(body.mode).toBe("local");
  });

  it("omits cli_version when the version is unknown", async () => {
    versionState.override = "0.0.0";
    await trackEvent("build", "syn_key", "/tmp/project");
    expect(sentBody()).not.toHaveProperty("cli_version");
  });

  it("never throws when the request fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(trackEvent("build", "syn_key", "/tmp/project")).resolves.toBeUndefined();
  });
});

// Build outcome fields (SYN-314). Older ui-backends ignore unknown fields.
describe("trackEvent build outcome", () => {
  const saved = {
    api: process.env.SYNAPSE_API_URL,
    telemetry: process.env.SYNAPSE_TELEMETRY,
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  function sentBody(): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  beforeEach(() => {
    process.env.SYNAPSE_API_URL = "https://api.example.test";
    delete process.env.SYNAPSE_TELEMETRY;
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved.api === undefined) delete process.env.SYNAPSE_API_URL;
    else process.env.SYNAPSE_API_URL = saved.api;
    if (saved.telemetry === undefined) delete process.env.SYNAPSE_TELEMETRY;
    else process.env.SYNAPSE_TELEMETRY = saved.telemetry;
  });

  it("sends success, language and duration for a successful build", async () => {
    await trackEvent("build", "syn_key", "/tmp/p", 0, 2, 11, 1234.6, "hosted", {
      success: true,
      language: "python",
    });
    const body = sentBody();
    expect(body.success).toBe(true);
    expect(body.language).toBe("python");
    expect(body.duration_ms).toBe(1235);
    expect(body.tool_count).toBe(2);
    expect(body.candidate_count).toBe(11);
    expect(body).not.toHaveProperty("error_code");
  });

  it("sends success=false and the error code for a failed build", async () => {
    await trackEvent("build", "syn_key", "/tmp/p", 0, 0, 4, 50, "hosted", {
      success: false,
      errorCode: "AUTH_INVALID",
    });
    const body = sentBody();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe("AUTH_INVALID");
  });

  it("leaves outcome fields out of events that don't set them", async () => {
    await trackEvent("init", "syn_key", "/tmp/p");
    const body = sentBody();
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("error_code");
  });
});

// `synapse init` key check (SYN-314) — offline-tolerant.
describe("verifyApiKey", () => {
  const savedApi = process.env.SYNAPSE_API_URL;
  beforeEach(() => {
    process.env.SYNAPSE_API_URL = "https://api.example.test/";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedApi === undefined) delete process.env.SYNAPSE_API_URL;
    else process.env.SYNAPSE_API_URL = savedApi;
  });

  it("calls /quota with the key and reports valid on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyApiKey("syn_key")).resolves.toBe("valid");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/quota");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer syn_key");
  });

  it("reports rejected on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(verifyApiKey("bad")).resolves.toBe("rejected");
  });

  it("reports unknown when the backend is down or unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(verifyApiKey("k")).resolves.toBe("unknown");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(verifyApiKey("k")).resolves.toBe("unknown");
  });

  it("doesn't retry an answer from the backend (200, 401, 5xx)", async () => {
    for (const status of [200, 401, 503]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status }));
      const onRetry = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await verifyApiKey("k", { onRetry });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it("checks the key even with telemetry disabled", async () => {
    process.env.SYNAPSE_TELEMETRY = "0";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    try {
      await expect(verifyApiKey("bad")).resolves.toBe("rejected");
    } finally {
      delete process.env.SYNAPSE_TELEMETRY;
    }
  });
});

// Cold start (SYN-321): a cold ui-backend takes ~14 s to answer /quota, past
// the first attempt's 10 s timeout. verifyApiKey retries once with a longer
// timeout and tells the caller, so a valid key still verifies.
describe("verifyApiKey cold start", () => {
  const savedApi = process.env.SYNAPSE_API_URL;

  /** fetch that answers after `delayMs`, or rejects when its signal aborts. */
  function slowFetch(delayMs: number, status = 200) {
    return vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("{}", { status })), delayMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
  }

  beforeEach(() => {
    process.env.SYNAPSE_API_URL = "https://api.example.test";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (savedApi === undefined) delete process.env.SYNAPSE_API_URL;
    else process.env.SYNAPSE_API_URL = savedApi;
  });

  it("retries once after a timeout and verifies a key the cold backend accepts", async () => {
    // First request hangs past 10 s (instance starting); the retry is answered
    // by the now-warm instance.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(slowFetch(60_000))
      .mockImplementationOnce(slowFetch(4_000));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();

    const result = verifyApiKey("syn_key", { onRetry });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(result).resolves.toBe("valid");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives the retry a longer timeout (~30 s in all)", async () => {
    // The first attempt times out at 10 s; the retry needs 15 s, which only
    // fits because the retry's timeout is longer (20 s).
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(slowFetch(25_000))
      .mockImplementationOnce(slowFetch(15_000));
    vi.stubGlobal("fetch", fetchMock);

    const result = verifyApiKey("syn_key");
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toBe("valid");
  });

  it("still reports a rejected key on the retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(
        new Response("", { status: 401 }),
      ),
    );
    await expect(verifyApiKey("bad")).resolves.toBe("rejected");
  });

  it("reports unknown when both attempts time out, within ~30 s", async () => {
    const fetchMock = vi.fn(slowFetch(120_000));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();

    const result = verifyApiKey("syn_key", { onRetry });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("never lets a throwing onRetry break the check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(
        new Response("{}", { status: 200 }),
      ),
    );
    await expect(
      verifyApiKey("k", {
        onRetry: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBe("valid");
  });
});
