// src/commands/shared/lines-delta.ts
//
// Lines-indexed quota accounting shared by `synapse analyze` (v1) and the v2
// hosted build (SYN-315).
//
// Each command reports only the lines it has not reported before: it keeps
// the last reported total in `.synapse/statistics.prev.json`, sends the
// positive difference as an `analyze` event, and moves the baseline forward
// ONLY when the server accepted the event. A failed send (timeout, 401, 500,
// 429) leaves the baseline alone, so the same lines are sent again next run.
//
// File format: a flat JSON object. v1 has always written
// `{ "total_lines_analyzed": N }`; v2 keeps its own key next to it
// (`v2_lines_indexed`) because the two engines count different file sets
// (v1: every .py file; v2: the files its prefilter hands to the parser), and
// sharing one number would make them re-charge each other's lines.

import fs from "node:fs";
import path from "node:path";
import { t } from "../../ui/theme.js";
import { roundedBox } from "../../ui/box.js";
import type { EventOutcome } from "../../grpc/telemetry.js";

export const PREV_STATS_FILE = "statistics.prev.json";

/** Key in statistics.prev.json holding the last reported total. */
export type LinesBaselineKey = "total_lines_analyzed" | "v2_lines_indexed";

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

/** Last reported total for `key`; 0 when the file or key is missing or bad. */
export function readPrevLines(synapseDir: string, key: LinesBaselineKey): number {
  const v = readPrevStats(synapseDir)[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Store `total` under `key`, keeping any other keys in the file. Non-fatal. */
export function writePrevLines(
  synapseDir: string,
  key: LinesBaselineKey,
  total: number,
): void {
  try {
    const data = readPrevStats(synapseDir);
    data[key] = total;
    fs.mkdirSync(synapseDir, { recursive: true });
    fs.writeFileSync(prevStatsPath(synapseDir), JSON.stringify(data));
  } catch {
    /* non-fatal */
  }
}

export type LinesReport =
  /** Nothing new to report; baseline updated. */
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
  /** Total lines this run scanned. */
  totalLines: number;
  key: LinesBaselineKey;
  /**
   * Never lower the stored baseline. v2 uses this because Auto and Custom
   * mode scan different file sets; without it, alternating modes would
   * re-charge the same lines every time the total went back up.
   */
  highWater?: boolean;
  /** Outcome fields for the `analyze` event (SYN-321), e.g. `{ success: true }`. */
  outcome?: EventOutcome;
}

/** Send the lines delta for this run and move the baseline only on success. */
export async function reportIndexedLines(opts: ReportLinesOptions): Promise<LinesReport> {
  const prev = readPrevLines(opts.synapseDir, opts.key);
  const total = Math.max(0, Math.floor(opts.totalLines));
  const next = opts.highWater ? Math.max(prev, total) : total;
  const delta = Math.max(total - prev, 0);

  if (delta === 0) {
    if (next !== prev) writePrevLines(opts.synapseDir, opts.key, next);
    return { kind: "unchanged" };
  }
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
    writePrevLines(opts.synapseDir, opts.key, next);
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
