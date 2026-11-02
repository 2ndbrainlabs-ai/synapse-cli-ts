// Every gRPC call (including the Build streams) carries the CLI version as
// `x-synapse-cli-version` metadata (SYN-367).

import { describe, it, expect, vi } from "vitest";
import * as grpc from "@grpc/grpc-js";

const versionState = vi.hoisted(() => ({ override: null as string | null }));
vi.mock("../../../src/utils/version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/utils/version.js")>();
  return { ...actual, readCliVersion: () => versionState.override ?? actual.readCliVersion() };
});

import { callMetadata } from "../../../src/grpc/client.js";
import { readCliVersion } from "../../../src/utils/version.js";

describe("callMetadata", () => {
  it("sends the API key and the CLI version", () => {
    versionState.override = null;
    const md = callMetadata(grpc, "syn_key");
    expect(md.get("x-api-key")).toEqual(["syn_key"]);
    expect(md.get("x-synapse-cli-version")).toEqual([readCliVersion()]);
    expect(readCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("leaves the version out when it is unknown", () => {
    versionState.override = "0.0.0";
    const md = callMetadata(grpc, "syn_key");
    expect(md.get("x-synapse-cli-version")).toEqual([]);
    expect(md.get("x-api-key")).toEqual(["syn_key"]);
  });
});
