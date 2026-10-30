// src/ui/errors.ts
//
// Structured error surface for the v2 CLI.
//
// Every user-facing failure should route through renderErrorBox so the user
// sees a consistent shape: [error code] one-liner, hint, top-N technical
// lines collapsed, and a "quote this when reporting" session id + log path.

import path from "node:path";
import { getProjectSynapseDir } from "../config/paths.js";
import { roundedBox } from "./box.js";
import { t } from "./theme.js";

// -----------------------------------------------------------------------------
// Wire schema — mirrors backend synapse_backend/services/_errors.py
// -----------------------------------------------------------------------------

export interface WireError {
  error_code: string;
  user_message: string;
  technical: string;
  hint: string;
  missing_fields: string[];
  extra: Record<string, unknown>;
}

/** Parse a wire error string (backend emits JSON). Returns null for legacy
 *  plain-string errors so callers can fall back to a plain box. */
export function parseWireError(raw: string): WireError | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.error_code !== "string") return null;
    return {
      error_code: String(parsed.error_code),
      user_message: String(parsed.user_message ?? ""),
      technical: String(parsed.technical ?? ""),
      hint: String(parsed.hint ?? ""),
      missing_fields: Array.isArray(parsed.missing_fields) ? parsed.missing_fields.map(String) : [],
      extra: (parsed.extra && typeof parsed.extra === "object") ? parsed.extra : {},
    };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Client-side error catalogue (mirrors _errors.py codes)
// -----------------------------------------------------------------------------

/** Well-known error codes the CLI knows how to render. Backend adds new ones
 *  freely — unknown codes still render as a generic box with the code shown. */
export const ERROR_CODES = {
  MANIFEST_INVALID: "MANIFEST_INVALID",
  REQUEST_INVALID: "REQUEST_INVALID",
  LLM_UNAVAILABLE: "LLM_UNAVAILABLE",
  LLM_OUTPUT_INVALID: "LLM_OUTPUT_INVALID",
  RENDER_FAILED: "RENDER_FAILED",
  VERIFIER_CRASHED: "VERIFIER_CRASHED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // CLI-side codes
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  NO_WORKFLOW_CLUSTERS: "NO_WORKFLOW_CLUSTERS",
  EXTRACTOR_FAILED: "EXTRACTOR_FAILED",
  // CLI-side codes for failures the CLI classifies itself (SYN-314).
  AUTH_INVALID: "AUTH_INVALID",
  MISSING_API_KEY: "MISSING_API_KEY",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
  SERVER_ERROR: "SERVER_ERROR",
  LOCAL_BUILD_FAILED: "LOCAL_BUILD_FAILED",
} as const;

// -----------------------------------------------------------------------------
// classifyFailure — turn whatever a client returned into an accurate cause
//
// A failure reaches the CLI as one of:
//   - a structured wire payload from the backend (JSON, parseWireError),
//   - a gRPC status string from client.ts: "gRPC error: 16: Invalid or …",
//     possibly wrapped ("Classifier failed after 3 attempts: gRPC error: 14: …"),
//   - a plain string (local in-process backend, client-side timeouts).
//
// Messages that blame the LLM are kept only for real LLM output failures:
// auth, connectivity and server bugs each get their own code and advice.
// -----------------------------------------------------------------------------

/** Backend codes rendered as the backend wrote them. Any other code — and
 *  INTERNAL_ERROR — is a server problem the user can't fix by re-running. */
const PASSTHROUGH_WIRE_CODES = new Set<string>([
  ERROR_CODES.MANIFEST_INVALID,
  ERROR_CODES.REQUEST_INVALID,
  ERROR_CODES.LLM_UNAVAILABLE,
  ERROR_CODES.LLM_OUTPUT_INVALID,
  ERROR_CODES.RENDER_FAILED,
  ERROR_CODES.VERIFIER_CRASHED,
]);

/** A Python programming error in `technical` means the server's own code
 *  broke, even if the backend labelled it LLM_OUTPUT_INVALID. */
const SERVER_BUG_RE =
  /^(TypeError|AttributeError|NameError|ImportError|ModuleNotFoundError|UnboundLocalError|AssertionError|RecursionError)\b/;

const GRPC_RE = /gRPC error: (\d+|[A-Z_]+): ?([\s\S]*)$/;

const GRPC_NAMES: Record<string, number> = {
  UNKNOWN: 2,
  DEADLINE_EXCEEDED: 4,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
};

export interface ClassifyOpts {
  /** "local" failures come from the user's own model provider, not Synapse. */
  mode?: "hosted" | "local";
  /** Where the API key in use came from — named in the auth fix. */
  keySource?: "env" | "project" | "global";
}

const KEY_SOURCE_LABEL: Record<NonNullable<ClassifyOpts["keySource"]>, string> = {
  env: "the SYNAPSE_API_KEY environment variable",
  project: "this project's config (.synapse/)",
  global: "your global config (~/.synapse/)",
};

/** Human label for an API key source, e.g. in `synapse init`. */
export function apiKeySourceLabel(source: NonNullable<ClassifyOpts["keySource"]>): string {
  return KEY_SOURCE_LABEL[source];
}

const REPORT_HINT =
  "This is a problem on the Synapse server, not in your code or key. " +
  "Please report it with the session id below.";

/** Message for an invalid key, with the fix for the key source in use. */
export function authInvalidError(technical = "", keySource?: ClassifyOpts["keySource"]): WireError {
  const hint =
    keySource === "env"
      ? "The key comes from SYNAPSE_API_KEY, which overrides saved keys. " +
        "Set it to a valid key, or unset it to use your saved key."
      : (keySource ? `The key comes from ${KEY_SOURCE_LABEL[keySource]}. ` : "") +
        "Save a valid key with `synapse config set-key`, or export SYNAPSE_API_KEY.";
  return legacyError(
    ERROR_CODES.AUTH_INVALID,
    "Your Synapse API key is invalid or expired.",
    hint,
    technical,
  );
}

export function backendUnavailableError(technical = ""): WireError {
  return legacyError(
    ERROR_CODES.BACKEND_UNAVAILABLE,
    "Couldn't reach the Synapse backend.",
    "Check your network connection and try again in a minute.",
    technical,
  );
}

export function serverError(technical = "", code: string = ERROR_CODES.SERVER_ERROR): WireError {
  return legacyError(code, "The Synapse server hit an internal error.", REPORT_HINT, technical);
}

function fromGrpcStatus(status: number, details: string, opts: ClassifyOpts): WireError {
  switch (status) {
    case 16: // UNAUTHENTICATED
      return authInvalidError(details, opts.keySource);
    case 8: // RESOURCE_EXHAUSTED — rate limit or credits/quota
      return legacyError(
        ERROR_CODES.QUOTA_EXCEEDED,
        details || "Your Synapse quota or rate limit is exhausted.",
        "Check your usage with `synapse info`.",
      );
    case 4: // DEADLINE_EXCEEDED
    case 14: // UNAVAILABLE
      return backendUnavailableError(details);
    default:
      return serverError(details ? `gRPC ${status}: ${details}` : `gRPC ${status}`);
  }
}

export function classifyFailure(raw: string, opts: ClassifyOpts = {}): WireError {
  const text = (raw ?? "").trim();
  const wire = parseWireError(text);

  if (wire) {
    if (!PASSTHROUGH_WIRE_CODES.has(wire.error_code)) {
      // INTERNAL_ERROR or a code this CLI doesn't know yet. Keep the code and
      // the backend's own words as details, but no "re-run" advice.
      const technical = [wire.user_message, wire.technical].filter(Boolean).join("\n");
      return serverError(technical, wire.error_code);
    }
    if (
      wire.error_code === ERROR_CODES.LLM_OUTPUT_INVALID &&
      SERVER_BUG_RE.test(wire.technical.trim())
    ) {
      return serverError(wire.technical);
    }
    return wire;
  }

  const grpc = GRPC_RE.exec(text);
  if (grpc) {
    const status = /^\d+$/.test(grpc[1]) ? Number(grpc[1]) : (GRPC_NAMES[grpc[1]] ?? 2);
    return fromGrpcStatus(status, grpc[2].trim(), opts);
  }

  if (/missing api key/i.test(text)) {
    return legacyError(
      ERROR_CODES.MISSING_API_KEY,
      "No Synapse API key found.",
      "Run `synapse init` or set SYNAPSE_API_KEY.",
    );
  }

  if (opts.mode === "local") {
    return legacyError(ERROR_CODES.LOCAL_BUILD_FAILED, text || "The local build failed.");
  }

  if (/^timeout after|timed out|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(text)) {
    return backendUnavailableError(text);
  }

  return serverError(text);
}

// -----------------------------------------------------------------------------
// renderErrorBox — the one entry point every failure path should call
// -----------------------------------------------------------------------------

export interface RenderErrorOpts {
  /** Fallback title if the code isn't recognised. */
  title?: string;
  /** Structured backend payload or raw string. */
  wire?: string | WireError | null;
  /** Session id — always printed so users can quote it. */
  sessionId?: string;
  /** Working dir — used to build the ledger path shown in the box. */
  workingDir?: string;
  /** CLI-side fallback when we don't have a wire payload. */
  fallback?: { code: string; message: string; hint?: string };
}

function ledgerHint(workingDir: string | undefined, sessionId: string | undefined): string | null {
  if (!workingDir || !sessionId) return null;
  const p = path.join(getProjectSynapseDir(workingDir), "discover", `${sessionId}.jsonl`);
  return p;
}

export function renderErrorBox(opts: RenderErrorOpts): void {
  const wire =
    typeof opts.wire === "string" ? parseWireError(opts.wire) :
    opts.wire ?? null;

  const code = wire?.error_code ?? opts.fallback?.code ?? "ERROR";
  const summary = wire?.user_message ?? opts.fallback?.message ?? "Unknown error";
  const hint = wire?.hint ?? opts.fallback?.hint ?? "";
  const technical = (wire?.technical ?? "").trim();
  const missing = wire?.missing_fields ?? [];

  const lines: string[] = [];
  // Summary first — the human-readable one-liner. Code tucked in muted subtle.
  lines.push(`${t.warm(summary)}  ${t.subtle("[" + code + "]")}`);

  if (missing.length > 0) {
    lines.push("");
    lines.push(t.bold("Missing fields:"));
    for (const f of missing.slice(0, 6)) lines.push(`  ${t.warn("!")}  ${t.warm(f)}`);
    if (missing.length > 6) lines.push(t.subtle(`  … and ${missing.length - 6} more`));
  }
  if (technical) {
    lines.push("");
    lines.push(t.bold("Details:"));
    for (const line of technical.split("\n").slice(0, 6)) {
      lines.push(`  ${t.subtle(line)}`);
    }
  }
  if (hint) {
    lines.push("");
    lines.push(`${t.info("i")}  ${t.warm(hint)}`);
  }
  const ledger = ledgerHint(opts.workingDir, opts.sessionId);
  if (opts.sessionId || ledger) {
    lines.push("");
    if (opts.sessionId) lines.push(`${t.bold("Session:")} ${t.subtle(opts.sessionId)}`);
    if (ledger) lines.push(`${t.bold("Logs:")}    ${t.subtle(ledger)}`);
    lines.push(t.italic(t.subtle("Share these when reporting an issue.")));
  }

  roundedBox({
    glyph: "✗",
    glyphColor: t.err,
    title: opts.title ?? "Synapse Error",
    body: lines,
  });
}

/** Convenience: for legacy code paths that still emit plain-string errors,
 *  wrap them in a wire-shaped payload so renderErrorBox stays consistent. */
export function legacyError(
  code: string,
  message: string,
  hint?: string,
  technical = "",
): WireError {
  return {
    error_code: code,
    user_message: message,
    technical,
    hint: hint ?? "",
    missing_fields: [],
    extra: {},
  };
}
