// `synapse init` checks the key it will use and names where it came from
// (SYN-314). The backend is mocked; an unreachable backend never blocks init.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = vi.hoisted(() => ({ home: "" }));

// Keep the global config out of the real ~/.synapse.
vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  const nodePath = await import("node:path");
  const nodeOs = await import("node:os");
  const nodeFs = await import("node:fs");
  tmp.home = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "synapse-init-home-"));
  return {
    ...actual,
    GLOBAL_SYNAPSE_DIR: nodePath.join(tmp.home, ".synapse"),
    GLOBAL_CONFIG_PATH: nodePath.join(tmp.home, ".synapse", "config.json"),
  };
});

import { runInit } from "../../../src/commands/init.js";
import { hasProjectApiKey } from "../../../src/config/manager.js";

describe("synapse init key check", () => {
  const saved = {
    key: process.env.SYNAPSE_API_KEY,
    api: process.env.SYNAPSE_API_URL,
    telemetry: process.env.SYNAPSE_TELEMETRY,
  };
  let project: string;
  let printed: string[];

  function stubQuota(response: Response | Error): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/quota")) {
          if (response instanceof Error) throw response;
          return response;
        }
        return new Response(null, { status: 200 });
      }),
    );
  }

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-init-proj-"));
    vi.spyOn(process, "cwd").mockReturnValue(project);
    printed = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    process.env.SYNAPSE_API_KEY = "syn_env_key";
    process.env.SYNAPSE_API_URL = "https://api.example.test";
    process.env.SYNAPSE_TELEMETRY = "0";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(project, { recursive: true, force: true });
    for (const [k, v] of [
      ["SYNAPSE_API_KEY", saved.key],
      ["SYNAPSE_API_URL", saved.api],
      ["SYNAPSE_TELEMETRY", saved.telemetry],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("names the environment as the key source and doesn't save that key", async () => {
    stubQuota(new Response("{}", { status: 200 }));
    await runInit({ force: false });
    const out = printed.join("\n");
    expect(out).toMatch(/Using existing API key from the SYNAPSE_API_KEY environment variable/);
    expect(out).not.toMatch(/global API key/);
    expect(out).toMatch(/API key verified/);
    expect(hasProjectApiKey(project)).toBe(false);
  });

  it("warns clearly when the backend rejects the key", async () => {
    stubQuota(new Response("", { status: 401 }));
    await runInit({ force: false });
    // Box lines wrap at terminal width — compare the text without the frame.
    const out = printed.join(" ").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
    expect(out).toMatch(/API Key Rejected/);
    expect(out).toMatch(/rejected the API key from the SYNAPSE_API_KEY environment variable/);
    // Still initialized — the warning doesn't block setup.
    expect(fs.existsSync(path.join(project, ".synapse", "config.json"))).toBe(true);
  });

  it("stays offline-tolerant when the backend can't be reached", async () => {
    stubQuota(new TypeError("fetch failed"));
    await runInit({ force: false });
    const out = printed.join("\n");
    expect(out).toMatch(/Couldn't reach Synapse to verify the API key/);
    expect(out).not.toMatch(/Rejected/);
    expect(fs.existsSync(path.join(project, ".synapse", "config.json"))).toBe(true);
  });

  // SYN-321: the first request to a cold ui-backend can outlast the first
  // attempt; init retries and says it's waking Synapse up.
  it("verifies a valid key when the first request to a cold backend fails", async () => {
    const quota = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/quota") ? quota() : new Response(null, { status: 200 }),
      ),
    );
    await runInit({ force: false });
    const out = printed.join("\n");
    expect(out).toMatch(/Waking up Synapse/);
    expect(out).toMatch(/API key verified/);
    expect(out).not.toMatch(/continuing offline/);
    expect(quota).toHaveBeenCalledTimes(2);
  });

  describe("init telemetry outcome", () => {
    function stubWithTelemetry(quota: Response): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
        String(url).endsWith("/quota") ? quota : new Response(null, { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    async function initEvent(fetchMock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
      let body: Record<string, unknown> | undefined;
      await vi.waitFor(() => {
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/telemetry/cli"));
        expect(call).toBeDefined();
        body = JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
      });
      return body!;
    }

    beforeEach(() => {
      delete process.env.SYNAPSE_TELEMETRY;
    });

    it("sends success=true when init completes", async () => {
      const fetchMock = stubWithTelemetry(new Response("{}", { status: 200 }));
      await runInit({ force: false });
      const body = await initEvent(fetchMock);
      expect(body.event_type).toBe("init");
      expect(body.success).toBe(true);
      expect(body).not.toHaveProperty("error_code");
    });

    it("sends success=false and AUTH_INVALID when the key is rejected", async () => {
      const fetchMock = stubWithTelemetry(new Response("", { status: 401 }));
      await runInit({ force: false });
      const body = await initEvent(fetchMock);
      expect(body.success).toBe(false);
      expect(body.error_code).toBe("AUTH_INVALID");
    });
  });
});
