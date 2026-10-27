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

import { trackEvent } from "../../../src/grpc/telemetry.js";
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
