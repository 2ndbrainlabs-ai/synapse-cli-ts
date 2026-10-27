// src/commands/v2/build-outcome.ts
//
// How a v2 build reports its outcome (SYN-314).
//
// Every failure or abort path renders its own box, then throws BuildFailure.
// runBuildV2 catches it once, sets a non-zero process.exitCode and sends the
// `build` telemetry event with success=false and the failure code — so no
// path can print an error and still exit 0.

import { UiBackendError } from "../../backend/ui-client.js";
import {
  ERROR_CODES,
  authInvalidError,
  backendUnavailableError,
  legacyError,
  serverError,
  type WireError,
} from "../../ui/errors.js";

/** Codes for builds that stop before anything is generated. */
export const OUTCOME_CODES = {
  NOT_INITIALIZED: "NOT_INITIALIZED",
  MISSING_API_KEY: ERROR_CODES.MISSING_API_KEY,
  LLM_NOT_READY: "LLM_NOT_READY",
  NOTHING_TO_RESUME: "NOTHING_TO_RESUME",
  CANCELLED: "CANCELLED",
  SESSION_PAUSED: "SESSION_PAUSED",
  EXTRACTOR_FAILED: ERROR_CODES.EXTRACTOR_FAILED,
  NO_ENDPOINTS: "NO_ENDPOINTS",
  NO_ENDPOINTS_SELECTED: "NO_ENDPOINTS_SELECTED",
  ENDPOINT_SELECTION_REQUIRED: "ENDPOINT_SELECTION_REQUIRED",
  ENDPOINTS_NOT_MATCHED: "ENDPOINTS_NOT_MATCHED",
  NO_FUNCTIONS: "NO_FUNCTIONS",
  NO_FUNCTIONS_SELECTED: "NO_FUNCTIONS_SELECTED",
  UNEXPECTED: "UNEXPECTED",
} as const;

/** Thrown after the failure has been shown to the user. */
export class BuildFailure extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BuildFailure";
  }
}

/** Filled in by the flows as the build progresses; read for telemetry. */
export interface BuildReport {
  /** Tools the build exposes: selected endpoints (auto) or composed tools (custom). */
  toolCount: number;
  /** Candidates the build chose from (detected endpoints or functions). */
  candidateCount: number;
}

/** Map a ui-backend (REST) failure to an accurate cause. */
export function uiBackendFailure(
  err: unknown,
  keySource?: "env" | "project" | "global",
): WireError {
  if (err instanceof UiBackendError) {
    if (err.status === 401) return authInvalidError(err.detail, keySource);
    if (err.status === 403 || err.status === 429) {
      return legacyError(
        ERROR_CODES.QUOTA_EXCEEDED,
        err.detail || "Your Synapse quota or rate limit is exhausted.",
        "Check your usage with `synapse info`.",
      );
    }
    if (err.status >= 500) return serverError(`HTTP ${err.status}: ${err.detail}`);
    return legacyError(ERROR_CODES.REQUEST_INVALID, err.detail || `HTTP ${err.status}`);
  }
  // fetch() rejects with a TypeError when the host can't be reached.
  return backendUnavailableError(err instanceof Error ? err.message : String(err));
}
