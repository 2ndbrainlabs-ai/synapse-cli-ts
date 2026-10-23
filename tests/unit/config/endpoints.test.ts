// Production endpoint defaults (SYN-254).
//
// The packaged root config.json supplies backend_url / api_url; getApiUrl()
// also carries a hard-coded fallback. Both must point at *.2ndbrainlabs.ai —
// never at the legacy synaps3.ai names or the dev hosts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getApiUrl } from "../../../src/config/manager.js";
import { SynapseClient } from "../../../src/grpc/client.js";

const ROOT_CONFIG = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../config.json"), "utf-8"),
) as { backend_url: string; api_url: string };

const FORBIDDEN = [/synaps3\.ai/i, /\.dev\.2ndbrainlabs\.ai/i];

describe("default endpoints", () => {
  const saved = {
    api: process.env.SYNAPSE_API_URL,
    backend: process.env.SYNAPSE_BACKEND_URL,
    dev: process.env.SYNAPSE_DEV,
  };

  beforeEach(() => {
    delete process.env.SYNAPSE_API_URL;
    delete process.env.SYNAPSE_BACKEND_URL;
    delete process.env.SYNAPSE_DEV;
  });

  afterEach(() => {
    for (const [k, v] of [
      ["SYNAPSE_API_URL", saved.api],
      ["SYNAPSE_BACKEND_URL", saved.backend],
      ["SYNAPSE_DEV", saved.dev],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("packaged config.json points at the production 2ndbrainlabs.ai hosts", () => {
    expect(ROOT_CONFIG.backend_url).toBe("https://grpc.synapse.2ndbrainlabs.ai");
    expect(ROOT_CONFIG.api_url).toBe("https://api.synapse.2ndbrainlabs.ai");
    for (const url of [ROOT_CONFIG.backend_url, ROOT_CONFIG.api_url]) {
      for (const bad of FORBIDDEN) expect(url).not.toMatch(bad);
    }
  });

  it("the packaged backend_url resolves to grpc.synapse.2ndbrainlabs.ai:443", () => {
    const client = new SynapseClient({ url: ROOT_CONFIG.backend_url }) as unknown as {
      host: string;
      port: number;
    };
    expect(client.host).toBe("grpc.synapse.2ndbrainlabs.ai");
    expect(client.port).toBe(443);
  });

  it("getApiUrl falls back to api.synapse.2ndbrainlabs.ai", () => {
    expect(getApiUrl()).toBe("https://api.synapse.2ndbrainlabs.ai");
  });

  it("env overrides still win, including a legacy synaps3.ai value", () => {
    process.env.SYNAPSE_API_URL = "https://api.synaps3.ai";
    expect(getApiUrl()).toBe("https://api.synaps3.ai");

    process.env.SYNAPSE_BACKEND_URL = "https://grpc.synaps3.ai";
    const client = new SynapseClient() as unknown as { host: string; port: number };
    expect(client.host).toBe("grpc.synaps3.ai");
    expect(client.port).toBe(443);
  });
});
