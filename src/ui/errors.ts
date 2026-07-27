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
} as const;

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
export function legacyError(code: string, message: string, hint?: string): WireError {
  return {
    error_code: code,
    user_message: message,
    technical: "",
    hint: hint ?? "",
    missing_fields: [],
    extra: {},
  };
}
