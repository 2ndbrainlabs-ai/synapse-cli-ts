// A quota rejection over gRPC is final, not transient (SYN-317).
//
// The backend's auth interceptor rejects a Build RPC with RESOURCE_EXHAUSTED
// (code 8) both for rate limiting ("Rate limit exceeded") and for hard limits
// ("Lines quota exceeded (…)", "MCP server quota exceeded (…)", "Credits
// exhausted"). Only the first can succeed on a retry; the CLI used to retry
// all of them with backoff. The gRPC service is faked here so each test can
// count how many times the RPC was opened.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

interface FakeError {
  code: number;
  details: string;
}

const fake = vi.hoisted(() => ({
  /** Error each Build call fails with (shifted per call; the last one repeats). */
  errors: [] as FakeError[],
  opened: 0,
}));

vi.mock("../../../src/grpc/proto-loader.js", () => {
  class FakeService {
    Build() {
      fake.opened += 1;
      const err = fake.errors.length > 1 ? fake.errors.shift()! : fake.errors[0];
      const call = Object.assign(new EventEmitter(), {
        write: () => {
          process.nextTick(() => call.emit("error", Object.assign(new Error(err.details), err)));
        },
        end: () => {},
      });
      return call;
    }
    close() {}
  }
  return { loadProto: () => ({ SynapseService: FakeService }) };
});

import { SynapseClient, isRetryableGrpcError } from "../../../src/grpc/client.js";
import { classifyFailure, ERROR_CODES } from "../../../src/ui/errors.js";

const LINES_QUOTA =
  "Lines quota exceeded (1200/1000). Contact synaps3.ai for extended limits.";
const SERVER_QUOTA =
  "MCP server quota exceeded (3/3). Contact synaps3.ai for extended limits.";

describe("isRetryableGrpcError", () => {
  it("does not retry RESOURCE_EXHAUSTED quota or credit rejections", () => {
    for (const details of [LINES_QUOTA, SERVER_QUOTA, "server quota reached", "Credits exhausted"]) {
      expect(isRetryableGrpcError({ code: 8, details })).toBe(false);
    }
  });

  it("still retries RESOURCE_EXHAUSTED rate limiting", () => {
    expect(isRetryableGrpcError({ code: 8, details: "Rate limit exceeded" })).toBe(true);
    expect(isRetryableGrpcError({ code: 8, details: "" })).toBe(true);
  });

  it("keeps the other transient codes and rejects the rest", () => {
    expect(isRetryableGrpcError({ code: 14, details: "No connection established" })).toBe(true);
    expect(isRetryableGrpcError({ code: 4, details: "quota" })).toBe(true);
    expect(isRetryableGrpcError({ code: 16, details: "Invalid or expired API key" })).toBe(false);
    expect(isRetryableGrpcError({ code: undefined, details: "" })).toBe(false);
  });
});

describe("SynapseClient retries on RESOURCE_EXHAUSTED", () => {
  const saved = process.env.SYNAPSE_API_KEY;
  let client: SynapseClient;

  beforeEach(() => {
    process.env.SYNAPSE_API_KEY = "syn_test_key";
    fake.errors = [];
    fake.opened = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    client = new SynapseClient({ url: "localhost:50051", workingDir: process.cwd() });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env.SYNAPSE_API_KEY;
    else process.env.SYNAPSE_API_KEY = saved;
  });

  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return p;
  }

  it("build: a lines-quota rejection is surfaced after one attempt with the server's words", async () => {
    fake.errors = [{ code: 8, details: LINES_QUOTA }];
    const res = await settle(client.build({ query: "q", projectSchema: "{}" }));

    expect(fake.opened).toBe(1);
    expect(res.success).toBe(false);
    expect(res.error).toBe(`gRPC error: 8: ${LINES_QUOTA}`);
    const wire = classifyFailure(res.error ?? "");
    expect(wire.error_code).toBe(ERROR_CODES.QUOTA_EXCEEDED);
    expect(wire.user_message).toBe(LINES_QUOTA);
  });

  it("build: rate limiting is still retried until it clears", async () => {
    fake.errors = [
      { code: 8, details: "Rate limit exceeded" },
      { code: 8, details: "Rate limit exceeded" },
      { code: 16, details: "Invalid or expired API key" },
    ];
    const res = await settle(client.build({ query: "q", projectSchema: "{}" }));

    expect(fake.opened).toBe(3);
    expect(res.error).toBe("gRPC error: 16: Invalid or expired API key");
  });

  it("classifyCandidates: a server-quota rejection is not retried", async () => {
    fake.errors = [{ code: 8, details: SERVER_QUOTA }];
    const res = await settle(client.classifyCandidates({ manifestJson: "{}" }));

    expect(fake.opened).toBe(1);
    expect(res.error).toBe(`gRPC error: 8: ${SERVER_QUOTA}`);
    expect(classifyFailure(res.error).error_code).toBe(ERROR_CODES.QUOTA_EXCEEDED);
  });

  it("classifyCandidates: rate limiting uses every attempt", async () => {
    fake.errors = [{ code: 8, details: "Rate limit exceeded" }];
    const res = await settle(client.classifyCandidates({ manifestJson: "{}" }));

    expect(fake.opened).toBe(3);
    expect(res.error).toMatch(/^Classifier failed after 3 attempts: gRPC error: 8: Rate limit/);
  });

  it("nameEndpoints: a quota rejection is not retried", async () => {
    fake.errors = [{ code: 8, details: LINES_QUOTA }];
    const res = await settle(client.nameEndpoints({ endpoints: [], workingDir: process.cwd() }));

    expect(fake.opened).toBe(1);
    expect(res.success).toBe(false);
  });
});
