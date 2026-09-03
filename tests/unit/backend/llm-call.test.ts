// Retry and degradation policy. Provider-agnostic by design, so it is driven
// with a scripted fake provider rather than HTTP: the point is *what we do*
// when a provider fails, which is invisible in adapter-level tests.
//
// Backoff sleeps for real seconds, so timers are faked and advanced manually.
// Telemetry is disabled so nothing leaves the process.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { callTool, PromptTooLongError, newTokenTotals } from "../../../src/backend/llm-call.js";
import { LlmError } from "../../../src/providers/types.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  Task,
} from "../../../src/providers/types.js";

const TOOL = {
  name: "emit_plan",
  description: "d",
  parameters: { type: "object", properties: {} },
};

const MODELS: Record<Task, string> = {
  triage: "m-triage",
  generate: "m-generate",
  verify: "m-verify",
  fallback_generate: "m-fallback",
};

/** Provider that replays a scripted list of outcomes and records requests. */
function fakeProvider(script: Array<LlmResponse | Error>): LlmProvider & {
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    id: "custom",
    label: "Fake",
    requests,
    modelFor: (task: Task) => MODELS[task],
    async send(req: LlmRequest): Promise<LlmResponse> {
      requests.push(structuredClone(req));
      const outcome = script[Math.min(i, script.length - 1)];
      i += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function ok(toolInput: Record<string, unknown> | null = { x: 1 }, model = "m-generate"): LlmResponse {
  return {
    toolInput,
    model,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  };
}

/** Drive fake timers until the promise settles, then surface its outcome. */
async function settle<T>(p: Promise<T>): Promise<T> {
  const guarded = p.then(
    (v) => ({ ok: true, v }) as const,
    (e) => ({ ok: false, e }) as const,
  );
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(25_000);
  const r = await guarded;
  if (r.ok) return r.v;
  throw r.e;
}

let savedTelemetry: string | undefined;
let session = 0;

/** Session state is module-level and keyed by id, so each test needs its own. */
function newSession(): string {
  session += 1;
  return `sess-${session}`;
}

beforeEach(() => {
  savedTelemetry = process.env.SYNAPSE_TELEMETRY;
  process.env.SYNAPSE_TELEMETRY = "0";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (savedTelemetry === undefined) delete process.env.SYNAPSE_TELEMETRY;
  else process.env.SYNAPSE_TELEMETRY = savedTelemetry;
});

// -----------------------------------------------------------------------------
// Happy path and request construction
// -----------------------------------------------------------------------------

describe("callTool — request construction", () => {
  it("returns the tool arguments and asks the provider for the task's model", async () => {
    const p = fakeProvider([ok()]);
    const out = await settle(
      callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );

    expect(out).toEqual({ x: 1 });
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].model).toBe("m-generate");
  });

  it("applies the per-task output-token budget", async () => {
    // Triage is a cheap high-volume pass; generation needs room for a file.
    const t = fakeProvider([ok()]);
    await settle(
      callTool({ provider: t, task: "triage", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(t.requests[0].maxTokens).toBe(4096);

    const g = fakeProvider([ok()]);
    await settle(
      callTool({ provider: g, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(g.requests[0].maxTokens).toBe(8192);
  });

  it("honours explicit model and maxTokens overrides", async () => {
    const p = fakeProvider([ok()]);
    await settle(
      callTool({
        provider: p,
        task: "generate",
        sessionId: newSession(),
        messages: [],
        tool: TOOL,
        model: "pinned-model",
        maxTokens: 123,
        temperature: 0.7,
      }),
    );
    expect(p.requests[0].model).toBe("pinned-model");
    expect(p.requests[0].maxTokens).toBe(123);
    expect(p.requests[0].temperature).toBe(0.7);
  });

  it("defaults temperature to 0 for reproducible codegen", async () => {
    const p = fakeProvider([ok()]);
    await settle(
      callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(p.requests[0].temperature).toBe(0);
  });

  it("normalises a string system prompt into one block", async () => {
    const p = fakeProvider([ok()]);
    await settle(
      callTool({
        provider: p,
        task: "generate",
        sessionId: newSession(),
        messages: [],
        tool: TOOL,
        system: "SYS",
      }),
    );
    expect(p.requests[0].system).toEqual([{ text: "SYS" }]);
  });

  it("passes system blocks through untouched, preserving cache hints", async () => {
    const p = fakeProvider([ok()]);
    const blocks = [{ text: "A", cache: true }, { text: "B" }];
    await settle(
      callTool({
        provider: p,
        task: "generate",
        sessionId: newSession(),
        messages: [],
        tool: TOOL,
        system: blocks,
      }),
    );
    expect(p.requests[0].system).toEqual(blocks);
  });

  it("treats an absent or empty system prompt as no blocks", async () => {
    for (const system of [undefined, ""]) {
      const p = fakeProvider([ok()]);
      await settle(
        callTool({
          provider: p,
          task: "generate",
          sessionId: newSession(),
          messages: [],
          tool: TOOL,
          system,
        }),
      );
      expect(p.requests[0].system).toEqual([]);
    }
  });
});

// -----------------------------------------------------------------------------
// Soft failure: no usable output
// -----------------------------------------------------------------------------

describe("callTool — unusable output", () => {
  it("returns null instead of throwing, and does not retry", async () => {
    // Callers retry with feedback or fall back to a default; that path is more
    // useful than an exception, especially on weaker models.
    const p = fakeProvider([ok(null)]);
    const out = await settle(
      callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(out).toBeNull();
    expect(p.requests).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Retry classification
// -----------------------------------------------------------------------------

describe("callTool — retry classification", () => {
  it.each([429, 500, 502, 503, 408])("retries HTTP %i and then succeeds", async (status) => {
    const p = fakeProvider([new LlmError("transient", { status }), ok()]);
    const out = await settle(
      callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(out).toEqual({ x: 1 });
    expect(p.requests).toHaveLength(2);
  });

  it("retries a connection failure that carries no status", async () => {
    const p = fakeProvider([new LlmError("econnrefused", { connection: true }), ok()]);
    await settle(
      callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(p.requests).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 422])(
    "does not retry HTTP %i — retrying a client error just burns quota",
    async (status) => {
      const p = fakeProvider([new LlmError("client error", { status })]);
      await expect(
        settle(
          callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
        ),
      ).rejects.toThrow(/client error/);
      expect(p.requests).toHaveLength(1);
    },
  );

  it("does not retry a non-LlmError thrown by a provider", async () => {
    const p = fakeProvider([new TypeError("bug in adapter")]);
    await expect(
      settle(
        callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
      ),
    ).rejects.toThrow(TypeError);
    expect(p.requests).toHaveLength(1);
  });

  it("gives up after MAX_RETRIES and rethrows the last error", async () => {
    const p = fakeProvider([new LlmError("always down", { status: 500 })]);
    await expect(
      settle(
        callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
      ),
    ).rejects.toThrow(/always down/);
    // 1 initial attempt + 3 retries.
    expect(p.requests).toHaveLength(4);
  });
});

// -----------------------------------------------------------------------------
// Context overflow
// -----------------------------------------------------------------------------

describe("callTool — context overflow", () => {
  it("converts promptTooLong into PromptTooLongError without retrying", async () => {
    // Retrying an oversized prompt cannot succeed; the caller must shrink it.
    const p = fakeProvider([new LlmError("maximum context length", { status: 400, promptTooLong: true })]);
    await expect(
      settle(
        callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
      ),
    ).rejects.toThrow(PromptTooLongError);
    expect(p.requests).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Overload degradation
// -----------------------------------------------------------------------------

describe("callTool — overload degradation", () => {
  it("swaps to the backup model after repeated overloads, and reports it", async () => {
    const overloaded = new LlmError("overloaded", { status: 529, overloaded: true });
    const p = fakeProvider([overloaded, overloaded, overloaded, ok()]);
    const statuses: Array<[string, string]> = [];

    const out = await settle(
      callTool({
        provider: p,
        task: "generate",
        sessionId: newSession(),
        messages: [],
        tool: TOOL,
        onStatus: (stage, msg) => {
          statuses.push([stage, msg]);
        },
      }),
    );

    expect(out).toEqual({ x: 1 });
    expect(p.requests).toHaveLength(4);
    // First three attempts on the primary, the fourth on the backup.
    expect(p.requests.slice(0, 3).map((r) => r.model)).toEqual([
      "m-generate",
      "m-generate",
      "m-generate",
    ]);
    expect(p.requests[3].model).toBe("m-fallback");
    // The user is told why the model changed under them.
    expect(statuses).toContainEqual(["retrying", "Provider congested — retrying on backup model"]);
  });

  it("degrades verify as well as generate", async () => {
    const overloaded = new LlmError("overloaded", { status: 529, overloaded: true });
    const p = fakeProvider([overloaded, overloaded, overloaded, ok()]);
    await settle(
      callTool({ provider: p, task: "verify", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(p.requests[3].model).toBe("m-fallback");
  });

  it("does not degrade triage — it already runs the cheap model", async () => {
    const overloaded = new LlmError("overloaded", { status: 529, overloaded: true });
    const p = fakeProvider([overloaded, overloaded, overloaded, ok()]);
    await settle(
      callTool({ provider: p, task: "triage", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(p.requests.map((r) => r.model)).toEqual([
      "m-triage",
      "m-triage",
      "m-triage",
      "m-triage",
    ]);
  });

  it("keeps the degradation for the rest of the session", async () => {
    // The swap is session-wide on purpose: once a provider is shedding load,
    // every later stage should start on the backup rather than rediscover it.
    const overloaded = new LlmError("overloaded", { status: 529, overloaded: true });
    const sessionId = newSession();

    const first = fakeProvider([overloaded, overloaded, overloaded, ok()]);
    await settle(
      callTool({ provider: first, task: "generate", sessionId, messages: [], tool: TOOL }),
    );

    const second = fakeProvider([ok()]);
    await settle(
      callTool({ provider: second, task: "generate", sessionId, messages: [], tool: TOOL }),
    );
    expect(second.requests[0].model).toBe("m-fallback");
  });

  it("isolates degradation to the session that hit it", async () => {
    const overloaded = new LlmError("overloaded", { status: 529, overloaded: true });
    const degraded = fakeProvider([overloaded, overloaded, overloaded, ok()]);
    await settle(
      callTool({ provider: degraded, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );

    const fresh = fakeProvider([ok()]);
    await settle(
      callTool({ provider: fresh, task: "generate", sessionId: newSession(), messages: [], tool: TOOL }),
    );
    expect(fresh.requests[0].model).toBe("m-generate");
  });

  it("resets the overload counter after a success, so blips don't accumulate", async () => {
    const overloaded = new LlmError("overloaded", { status: 529, overloaded: true });
    const sessionId = newSession();

    // Two overloads then success — below the threshold.
    const a = fakeProvider([overloaded, overloaded, ok()]);
    await settle(callTool({ provider: a, task: "generate", sessionId, messages: [], tool: TOOL }));

    // Two more overloads; without a reset these four would trip the swap.
    const b = fakeProvider([overloaded, overloaded, ok()]);
    await settle(callTool({ provider: b, task: "generate", sessionId, messages: [], tool: TOOL }));
    expect(b.requests.every((r) => r.model === "m-generate")).toBe(true);
  });

  it("survives an onStatus callback that throws", async () => {
    const overloaded = new LlmError("overloaded", { status: 529, overloaded: true });
    const p = fakeProvider([overloaded, overloaded, overloaded, ok()]);
    const out = await settle(
      callTool({
        provider: p,
        task: "generate",
        sessionId: newSession(),
        messages: [],
        tool: TOOL,
        onStatus: () => {
          throw new Error("ui blew up");
        },
      }),
    );
    expect(out).toEqual({ x: 1 });
  });
});

// -----------------------------------------------------------------------------
// Backoff timing
// -----------------------------------------------------------------------------

describe("callTool — backoff", () => {
  it("waits before retrying rather than hammering the provider", async () => {
    const p = fakeProvider([new LlmError("transient", { status: 500 }), ok()]);
    const promise = callTool({
      provider: p,
      task: "generate",
      sessionId: newSession(),
      messages: [],
      tool: TOOL,
    });
    const guarded = promise.catch(() => undefined);

    // Base delay is 400ms with jitter; nothing should have been retried yet.
    await vi.advanceTimersByTimeAsync(50);
    expect(p.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.requests).toHaveLength(2);
    await guarded;
  });

  it("respects a Retry-After hint instead of its own backoff", async () => {
    const p = fakeProvider([
      new LlmError("slow down", { status: 429, retryAfterSeconds: 7 }),
      ok(),
    ]);
    const promise = callTool({
      provider: p,
      task: "generate",
      sessionId: newSession(),
      messages: [],
      tool: TOOL,
    });
    const guarded = promise.catch(() => undefined);

    // Still waiting well past the default backoff would have fired.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(p.requests).toHaveLength(2);
    await guarded;
  });
});

// -----------------------------------------------------------------------------
// Token accounting
// -----------------------------------------------------------------------------

describe("callTool — token totals", () => {
  it("accumulates usage across calls so cost is comparable between providers", async () => {
    const totals = newTokenTotals();
    const sessionId = newSession();

    for (let i = 0; i < 3; i++) {
      const p = fakeProvider([ok({ x: i }, "srv-model")]);
      await settle(
        callTool({ provider: p, task: "generate", sessionId, messages: [], tool: TOOL, totals }),
      );
    }

    expect(totals.call_count).toBe(3);
    expect(totals.input_tokens).toBe(30);
    expect(totals.output_tokens).toBe(15);
    expect(totals.cache_read_input_tokens).toBe(6);
    expect(totals.cache_creation_input_tokens).toBe(3);
    // Records the model the provider actually served, not the one requested.
    expect(totals.last_model).toBe("srv-model");
  });

  it("does not count failed attempts", async () => {
    const totals = newTokenTotals();
    const p = fakeProvider([new LlmError("nope", { status: 401 })]);
    await settle(
      callTool({ provider: p, task: "generate", sessionId: newSession(), messages: [], tool: TOOL, totals }),
    ).catch(() => undefined);

    expect(totals.call_count).toBe(0);
    expect(totals.input_tokens).toBe(0);
  });

  it("starts from a zeroed accumulator", () => {
    expect(newTokenTotals()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      last_model: "",
      call_count: 0,
    });
  });
});
