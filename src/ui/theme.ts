/**
 * Synapse "Sunset Harmony" design system.
 *
 * Semantic tokens (not raw colors), three gray tiers, shimmer twins for animated
 * highlights. All UI code must import from here — no raw chalk.hex() elsewhere.
 */

import chalk from "chalk";
import { OK, ERR, WARN, INFO, ARROW, BOX, H_HEAVY } from "./icons.js";

// ---------------------------------------------------------------------------
// Environment detection (accessibility branches)
// ---------------------------------------------------------------------------

export const env = {
  isTTY: Boolean(process.stdout.isTTY),
  noColor: Boolean(process.env.NO_COLOR),
  noAnimation:
    Boolean(process.env.SYNAPSE_NO_ANIMATION) ||
    Boolean(process.env.NO_COLOR) ||
    !process.stdout.isTTY,
  columns: process.stdout.columns || 80,
};

// ---------------------------------------------------------------------------
// Palette — Sunset Harmony
// ---------------------------------------------------------------------------

const PALETTE = {
  // Brand — terracotta warmth
  brand: "#d97757",
  brandShim: "#eb9f7f",
  brandDim: "#c6613f",

  // Accent — gold
  accent: "#ffb020",
  accentShim: "#ffcf5c",

  // Text tiers (three explicit grays)
  text: "#f2ede4",
  warm: "#f5efe0", // cream — used in boxed content
  inactive: "#9a9791", // secondary metadata
  subtle: "#605d58", // tertiary / very dim

  // Surface
  surface: "#2a2724",

  // Semantic
  ok: "#4eba65",
  err: "#ff6b80",
  warn: "#ffc107",
  info: "#93a5ff", // periwinkle
  suggest: "#b1b9f9", // lavender

  // Special
  tan: "#b8956a", // italic file paths
  code: "#a5b4fc",
  num: "#ffd166",
} as const;

// ---------------------------------------------------------------------------
// Theme object — semantic helpers
// ---------------------------------------------------------------------------

export const t = {
  env,

  // Brand
  brand: (s: string) => chalk.hex(PALETTE.brand)(s),
  brandBold: (s: string) => chalk.hex(PALETTE.brand).bold(s),
  brandShim: (s: string) => chalk.hex(PALETTE.brandShim)(s),
  brandDim: (s: string) => chalk.hex(PALETTE.brandDim)(s),

  // Accent
  accent: (s: string) => chalk.hex(PALETTE.accent)(s),
  accentBold: (s: string) => chalk.hex(PALETTE.accent).bold(s),
  accentShim: (s: string) => chalk.hex(PALETTE.accentShim)(s),

  // Text tiers
  text: (s: string) => chalk.hex(PALETTE.text)(s),
  warm: (s: string) => chalk.hex(PALETTE.warm)(s),
  dim: (s: string) => chalk.hex(PALETTE.inactive)(s),
  subtle: (s: string) => chalk.hex(PALETTE.subtle)(s),
  bold: (s: string) => chalk.bold(s),
  /** @deprecated Alias for `subtle`. Use `t.subtle` in new code. */
  muted: (s: string) => chalk.hex(PALETTE.subtle)(s),

  // Semantic
  ok: (s: string) => chalk.hex(PALETTE.ok)(s),
  err: (s: string) => chalk.hex(PALETTE.err)(s),
  warn: (s: string) => chalk.hex(PALETTE.warn)(s),
  info: (s: string) => chalk.hex(PALETTE.info)(s),
  suggest: (s: string) => chalk.hex(PALETTE.suggest)(s),

  // Formatters
  path: (s: string) => chalk.hex(PALETTE.tan).italic(s),
  cmd: (s: string) => chalk.hex(PALETTE.brand).bold(s),
  code: (s: string) => chalk.hex(PALETTE.code)(s),
  num: (s: string) => chalk.hex(PALETTE.num)(s),
  kbd: (s: string) => chalk.hex(PALETTE.accent)(s),

  // Raw palette exposure (for spinners that need to blend colors)
  palette: PALETTE,
};

// ---------------------------------------------------------------------------
// Common primitives — section headers & step lines
// ---------------------------------------------------------------------------

/**
 * Compact section header — icon + title + underline sized to title width.
 *   🏗️  Building MCP Server
 *   ─────────────────────────
 */
export function sectionHeader(title: string, icon?: string): void {
  const label = icon ? `${icon}  ${title}` : title;
  const width = stripAnsi(label).length + 2;
  console.log();
  console.log(`  ${t.brandBold(label)}`);
  console.log(`  ${t.brand(H_HEAVY.repeat(width))}`);
  console.log();
}

/**
 * Full-width subtle divider between major sections.
 *   ──────────────────────────────────────────────  (no label)
 *   ──────────────── Label ─────────────────────── (with label)
 * Renders as empty line in NO_COLOR mode.
 */
export function printDivider(label?: string): void {
  if (t.env.noColor) { console.log(); return; }
  const cols = Math.max(20, (t.env.columns || 80) - 4);
  if (!label) {
    console.log(`  ${t.subtle(BOX.h.repeat(cols))}`);
    return;
  }
  const labelText = ` ${label} `;
  const total = Math.max(0, cols - labelText.length);
  const left = Math.floor(total / 2);
  const right = total - left;
  console.log(
    `  ${t.subtle(BOX.h.repeat(left))}${t.dim(labelText)}${t.subtle(BOX.h.repeat(right))}`,
  );
}

/**
 * Step line with a leading status glyph.
 *   ✓  Message  detail
 */
export function stepOk(label: string, detail = ""): void {
  const d = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.ok(OK)}  ${t.text(label)}${d}`);
}
export function stepErr(label: string, detail = ""): void {
  const d = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.err(ERR)}  ${t.text(label)}${d}`);
}
export function stepWarn(label: string, detail = ""): void {
  const d = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.warn(WARN)}  ${t.text(label)}${d}`);
}
export function stepInfo(label: string, detail = ""): void {
  const d = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.info(INFO)}  ${t.text(label)}${d}`);
}
export function stepBrand(label: string, detail = ""): void {
  const d = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.brand(ARROW)}  ${t.text(label)}${d}`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes so we can measure display width accurately. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Display width of a string, ignoring ANSI codes. Emoji count as 2. */
export function displayWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    // Rough wide-char detection (emoji, CJK)
    if (code > 0x1f000 || (code >= 0x2600 && code <= 0x27bf)) w += 2;
    else w += 1;
  }
  return w;
}

/** Compact "1m 3s" / "45s" duration formatter. */
export function fmtDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Legacy helpers — kept during migration, prefer new primitives
// ---------------------------------------------------------------------------

/** Horizontal rule in dim gray. Prefer using rounded boxes. */
export function hrLine(width = 56): string {
  return t.subtle("─".repeat(width));
}

/** Horizontal rule in brand color. */
export function hrBrand(width = 56): string {
  return t.brand("─".repeat(width));
}

/** Aligned key/value line. Prefer `kvGrid` from `./kv-grid.ts`. */
export function kvLine(key: string, value: string, keyWidth = 16): string {
  const padded = key.padEnd(keyWidth);
  return `${t.dim(padded)}  ${t.text(value)}`;
}

// ---------------------------------------------------------------------------
// Back-compat exports (used by older command files during migration)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `roundedBox` from `./box.ts` directly. Kept for migration.
 * NOTE: this now draws an actual rounded box (previously drew just a header rule).
 * Requires an eager import — imported below at module bottom to avoid a top-level
 * circular dependency with box.ts (which imports from theme.ts).
 */
let _roundedBoxImpl:
  | ((title: string, icon: string | undefined, color: (s: string) => string, lines: string[]) => void)
  | null = null;

export function _registerRoundedBox(
  impl: (title: string, icon: string | undefined, color: (s: string) => string, lines: string[]) => void,
): void {
  _roundedBoxImpl = impl;
}

export function sectionBox(
  title: string,
  variant: "ok" | "err" | "warn" | "info",
  lines: string[],
): void {
  const color =
    variant === "ok"
      ? t.ok
      : variant === "err"
        ? t.err
        : variant === "warn"
          ? t.warn
          : t.info;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl = _roundedBoxImpl as any;
  if (impl) {
    impl(title, undefined, color, lines);
    return;
  }
  // Fallback: header + lines if box.ts hasn't registered yet
  console.log();
  console.log(`  ${color(title)}`);
  for (const line of lines) console.log(`  ${line}`);
}

// Eager side-effect import so box.ts registers itself when `theme.ts` is loaded.
// Placed at the bottom so all named exports above are already defined.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import "./box.js";
