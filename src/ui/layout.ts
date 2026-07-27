/**
 * Terminal layout helpers — Ember responsive rules.
 *
 * Three breakpoints govern how every component renders:
 *
 *   narrow    cols <= 80        phone SSH, split panes
 *   medium    81 – 120          typical laptop terminal
 *   wide      121+              external monitor, ultrawide
 *
 * Universal content max-width is 96 columns — no component grows beyond this
 * even on ultrawide terminals. Matches book measure; keeps eye travel short.
 */

export type Breakpoint = "narrow" | "medium" | "wide";

/** Current terminal column count. Re-read on every call so a live resize
 *  during a long-running RPC is picked up on the next render tick. */
export function cols(): number {
  return process.stdout.columns || 80;
}

/** Which responsive tier are we in right now? */
export function breakpoint(): Breakpoint {
  const c = cols();
  if (c <= 80) return "narrow";
  if (c <= 120) return "medium";
  return "wide";
}

/** Universal content max-width for boxes / prose / kv-grids. */
export const CONTENT_MAX_WIDTH = 96;

/** Inner width of a rounded box — depends on breakpoint. */
export function boxInnerWidth(): number {
  const c = cols();
  const bp = breakpoint();
  if (bp === "narrow") return Math.max(28, c - 6);
  if (bp === "medium") return Math.min(88, c - 6);
  return 88; // wide caps at 88 inner, matching Vercel / Bun
}

/** Two-column layout width per column (for the dual-card mode picker). */
export function twoColumnWidth(): number {
  const inner = boxInnerWidth();
  return Math.max(20, Math.floor((inner - 3) / 2));
}

/** Is the runtime in a "we should degrade animations" state? */
export function isPlainOutput(): boolean {
  return (
    !process.stdout.isTTY ||
    Boolean(process.env.NO_COLOR) ||
    Boolean(process.env.CI) ||
    process.env.SYNAPSE_NO_ANIMATION === "1"
  );
}
