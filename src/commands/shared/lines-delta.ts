// src/commands/shared/lines-delta.ts
//
// Lines-indexed quota accounting shared by `synapse analyze` (v1) and the v2
// hosted build (SYN-315).
//
// Both commands share ONE high-water baseline per repo, so the same lines are
// never charged twice: `synapse analyze` followed by a hosted build (or the
// reverse) on unchanged code charges the second run nothing. Each run sends
// only the lines above the baseline as an `analyze` event, and raises the
// baseline ONLY when the server accepted the event. A failed send (timeout,
// 401, 500, 429) leaves the baseline alone, so the same lines are sent again
// next run. The baseline never goes down: the engines scan slightly different
// file sets (analyze: every supported file; v2: the files its prefilter hands
// to the parser), and a lowering baseline would let them re-charge each
// other's lines.
//
// File format: a flat JSON object in `.synapse/statistics.prev.json`. The
// shared key is `lines_indexed`. Older CLIs wrote `total_lines_analyzed`
// (analyze) and `v2_lines_indexed` (v2 build); they are still read (the
// baseline is the max of all three) and are kept equal to `lines_indexed` on
// write, so downgrading to an older CLI does not re-charge either.

import fs from "node:fs";
import path from "node:path";
import { t } from "../../ui/theme.js";
import { roundedBox } from "../../ui/box.js";
import type { EventOutcome } from "../../grpc/telemetry.js";

export const PREV_STATS_FILE = "statistics.prev.json";

/** Key holding the shared lines-indexed baseline. */
export const LINES_BASELINE_KEY = "lines_indexed";

/** Per-command keys written by older CLIs; read for migration, kept in sync. */
export const LEGACY_BASELINE_KEYS = ["total_lines_analyzed", "v2_lines_indexed"] as const;

export const DEFAULT_QUOTA_MESSAGE =
  "You've reached the lines-indexed limit for your plan. Run `synapse info` to see your usage.";

function prevStatsPath(synapseDir: string): string {
  return path.join(synapseDir, PREV_STATS_FILE);
}

function readPrevStats(synapseDir: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(prevStatsPath(synapseDir), "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asLines(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * The repo's lines-indexed baseline: the max of the shared key and the legacy
 * per-command keys. 0 when the file is missing or unreadable.
 */
export function readPrevLines(synapseDir: string): number {
  const data = readPrevStats(synapseDir);
  return Math.max(
    asLines(data[LINES_BASELINE_KEY]),
    ...LEGACY_BASELINE_KEYS.map((k) => asLines(data[k])),
  );
}

/** Store `total` as the baseline (shared and legacy keys), keeping other keys. Non-fatal. */
export function writePrevLines(synapseDir: string, total: number): void {
  try {
    const data = readPrevStats(synapseDir);
    data[LINES_BASELINE_KEY] = total;
    for (const k of LEGACY_BASELINE_KEYS) data[k] = total;
    fs.mkdirSync(synapseDir, { recursive: true });
    fs.writeFileSync(prevStatsPath(synapseDir), JSON.stringify(data));
  } catch {
    /* non-fatal */
  }
}

export type LinesReport =
  /** Nothing above the baseline; nothing sent. */
  | { kind: "unchanged" }
  /** Delta accepted by the server; baseline moved forward. */
  | { kind: "sent"; delta: number }
  /** No API key, so nothing was sent; baseline unchanged. */
  | { kind: "skipped"; delta: number }
  /** Server refused the delta because the quota is used up; baseline unchanged. */
  | { kind: "quota_exceeded"; delta: number; message: string }
  /** Any other failure (timeout, network, 401, 5xx, rate limit); baseline unchanged. */
  | { kind: "failed"; delta: number; status: number };

export interface ReportLinesOptions {
  apiKey: string;
  workingDir: string;
  synapseDir: string;
  /** Total lines this run scanned (counted with `countLines`). */
  totalLines: number;
  /** Outcome fields for the `analyze` event (SYN-321), e.g. `{ success: true }`. */
  outcome?: EventOutcome;
}

/** Send the lines delta for this run and move the baseline only on success. */
export async function reportIndexedLines(opts: ReportLinesOptions): Promise<LinesReport> {
  const prev = readPrevLines(opts.synapseDir);
  const total = Math.max(0, Math.floor(opts.totalLines));
  const delta = Math.max(total - prev, 0);

  if (delta === 0) return { kind: "unchanged" };
  if (!opts.apiKey) return { kind: "skipped", delta };

  const { trackEvent, isQuotaExceeded } = await import("../../grpc/telemetry.js");
  const result = await trackEvent(
    "analyze",
    opts.apiKey,
    opts.workingDir,
    delta,
    0,
    0,
    0,
    "hosted",
    opts.outcome ?? {},
  );

  if (result.ok) {
    writePrevLines(opts.synapseDir, total);
    return { kind: "sent", delta };
  }
  if (isQuotaExceeded(result)) {
    return { kind: "quota_exceeded", delta, message: result.detail || DEFAULT_QUOTA_MESSAGE };
  }
  return { kind: "failed", delta, status: result.status };
}

/** The quota-exceeded box, identical to the pre-flight check in build.ts. */
export function showQuotaExceeded(message: string): void {
  roundedBox("Quota Exceeded", "⚠", t.warn, [message || DEFAULT_QUOTA_MESSAGE]);
}
