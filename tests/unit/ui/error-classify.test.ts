// Failures are reported with their real cause (SYN-314).
//
// A gRPC UNAUTHENTICATED used to surface as [LLM_OUTPUT_INVALID] with advice
// to re-run, and so did a server-side TypeError. classifyFailure maps gRPC
// statuses and backend codes to accurate messages, keeping LLM wording for
// real LLM output failures only.

import { describe, it, expect } from "vitest";
import { classifyFailure, ERROR_CODES } from "../../../src/ui/errors.js";

function wire(code: string, technical = "", userMessage = "msg", hint = "hint"): string {
  return JSON.stringify({
    error_code: code,
    user_message: userMessage,
    technical,
    hint,
    missing_fields: [],
    extra: {},
  });
}

describe("classifyFailure: gRPC status strings", () => {
  it("maps 16 UNAUTHENTICATED to an invalid-key message with the fix", () => {
    const e = classifyFailure("gRPC error: 16: Invalid or expired API key");
    expect(e.error_code).toBe(ERROR_CODES.AUTH_INVALID);
    expect(e.user_message).toMatch(/API key is invalid or expired/);
    expect(e.hint).toMatch(/synapse config --key/);
    expect(e.hint).toMatch(/SYNAPSE_API_KEY/);
    expect(e.technical).toBe("Invalid or expired API key");
  });

  it("names SYNAPSE_API_KEY as the culprit when the key came from the environment", () => {
    const e = classifyFailure("gRPC error: 16: Invalid or expired API key", { keySource: "env" });
    expect(e.hint).toMatch(/comes from SYNAPSE_API_KEY/);
  });

  it("accepts symbolic status names", () => {
    expect(classifyFailure("gRPC error: UNAUTHENTICATED: nope").error_code).toBe(
      ERROR_CODES.AUTH_INVALID,
    );
  });

  it("maps UNAVAILABLE and DEADLINE_EXCEEDED to backend unreachable, even when wrapped", () => {
    const wrapped = classifyFailure(
      "Classifier failed after 3 attempts: gRPC error: 14: No connection established",
    );
    expect(wrapped.error_code).toBe(ERROR_CODES.BACKEND_UNAVAILABLE);
    expect(wrapped.user_message).toMatch(/Couldn't reach the Synapse backend/);
    expect(classifyFailure("gRPC error: 4: Deadline exceeded").error_code).toBe(
      ERROR_CODES.BACKEND_UNAVAILABLE,
    );
  });

  it("maps RESOURCE_EXHAUSTED to quota with the server's own words", () => {
    const e = classifyFailure("gRPC error: 8: Credits exhausted");
    expect(e.error_code).toBe(ERROR_CODES.QUOTA_EXCEEDED);
    expect(e.user_message).toBe("Credits exhausted");
  });

  it("maps INTERNAL and UNKNOWN to a generic server error", () => {
    for (const raw of ["gRPC error: 13: boom", "gRPC error: UNKNOWN: boom"]) {
      const e = classifyFailure(raw);
      expect(e.error_code).toBe(ERROR_CODES.SERVER_ERROR);
      expect(e.hint).toMatch(/report it with the session id/);
      expect(e.hint).not.toMatch(/re-run/i);
    }
  });
});

describe("classifyFailure: structured backend errors", () => {
  it("keeps a real LLM output failure as LLM_OUTPUT_INVALID", () => {
    const raw = wire(
      ERROR_CODES.LLM_OUTPUT_INVALID,
      "ValidationError: tool_name missing",
      "ToolShaper couldn't produce a valid plan after retries.",
      "Try narrowing the intent",
    );
    const e = classifyFailure(raw);
    expect(e.error_code).toBe(ERROR_CODES.LLM_OUTPUT_INVALID);
    expect(e.user_message).toMatch(/ToolShaper/);
  });

  it("reports a server code bug labelled LLM_OUTPUT_INVALID as a server error", () => {
    const raw = wire(
      ERROR_CODES.LLM_OUTPUT_INVALID,
      "TypeError: AsyncMessages.create() got an unexpected keyword argument 'temperature'",
      "ToolShaper couldn't produce a valid plan after retries.",
      "Try narrowing the intent (fewer functions) or re-run — sometimes the LLM needs a second attempt.",
    );
    const e = classifyFailure(raw);
    expect(e.error_code).toBe(ERROR_CODES.SERVER_ERROR);
    expect(e.user_message).not.toMatch(/LLM|ToolShaper/);
    expect(e.hint).not.toMatch(/re-run/i);
    expect(e.technical).toMatch(/^TypeError/);
  });

  it("reports INTERNAL_ERROR generically but keeps the code and details", () => {
    const e = classifyFailure(wire(ERROR_CODES.INTERNAL_ERROR, "KeyError: 'x'", "Synapse hit an internal error during 'shape'."));
    expect(e.error_code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(e.user_message).toBe("The Synapse server hit an internal error.");
    expect(e.technical).toMatch(/internal error during 'shape'/);
    expect(e.technical).toMatch(/KeyError/);
  });

  it("handles codes this CLI doesn't know yet without blaming the LLM", () => {
    const e = classifyFailure(wire("SOME_NEW_CODE", "details", "Something new broke", "re-run it"));
    expect(e.error_code).toBe("SOME_NEW_CODE");
    expect(e.user_message).toBe("The Synapse server hit an internal error.");
    expect(e.hint).not.toMatch(/re-run/i);
    expect(e.technical).toMatch(/Something new broke/);
  });

  // Codes the cli-backend returns after SYN-318, plus WORKFLOW_ERROR from
  // backends deployed before it.
  it("shows REQUEST_INVALID (e.g. prompt too long) with the backend's own fix", () => {
    const e = classifyFailure(
      wire(
        ERROR_CODES.REQUEST_INVALID,
        "",
        "The request is too large for the model.",
        "Select fewer functions, or narrow the intent.",
      ),
    );
    expect(e.error_code).toBe(ERROR_CODES.REQUEST_INVALID);
    expect(e.user_message).toBe("The request is too large for the model.");
    expect(e.hint).toBe("Select fewer functions, or narrow the intent.");
  });

  it("shows LLM_UNAVAILABLE as the backend wrote it", () => {
    const e = classifyFailure(
      wire(ERROR_CODES.LLM_UNAVAILABLE, "", "The LLM provider failed during 'shape'.", "Try again in a few minutes."),
    );
    expect(e.error_code).toBe(ERROR_CODES.LLM_UNAVAILABLE);
    expect(e.user_message).toMatch(/LLM provider failed/);
  });

  it("treats a legacy WORKFLOW_ERROR as a server error", () => {
    const e = classifyFailure(wire("WORKFLOW_ERROR", "RuntimeError: x", "Build failed", "re-run"));
    expect(e.error_code).toBe("WORKFLOW_ERROR");
    expect(e.user_message).toBe("The Synapse server hit an internal error.");
    expect(e.hint).not.toMatch(/re-run/i);
  });

  it("passes other known codes through unchanged", () => {
    const e = classifyFailure(wire(ERROR_CODES.MANIFEST_INVALID, "", "Manifest missing fields"));
    expect(e.error_code).toBe(ERROR_CODES.MANIFEST_INVALID);
    expect(e.user_message).toBe("Manifest missing fields");
  });
});

describe("classifyFailure: plain strings", () => {
  it("maps a missing key", () => {
    expect(classifyFailure("Missing API key. Run `synapse init`").error_code).toBe(
      ERROR_CODES.MISSING_API_KEY,
    );
  });

  it("maps client-side timeouts to backend unreachable", () => {
    expect(classifyFailure("timeout after 60000ms").error_code).toBe(
      ERROR_CODES.BACKEND_UNAVAILABLE,
    );
  });

  it("keeps a local-mode failure in the user's own words, not as a Synapse server error", () => {
    const e = classifyFailure("local-backend error: 429 rate limited", { mode: "local" });
    expect(e.error_code).toBe(ERROR_CODES.LOCAL_BUILD_FAILED);
    expect(e.user_message).toBe("local-backend error: 429 rate limited");
  });

  it("treats any other hosted string as a server error", () => {
    expect(classifyFailure("stream ended before result").error_code).toBe(
      ERROR_CODES.SERVER_ERROR,
    );
  });
});
