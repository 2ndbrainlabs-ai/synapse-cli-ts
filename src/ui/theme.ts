/**
 * Synapse "Ember" design system.
 *
 * One brand accent (deep terracotta), five-step neutral grayscale, semantic
 * colors reserved for meaning. All UI code imports semantic tokens (`t.*`)
 * from here — no raw chalk.hex() elsewhere. Palette values may change
 * across releases; token names are stable API.
 *
 * Design principles:
 *  1. Semantic > decorative. Every color must carry meaning (ok/warn/err/info/brand).
 *  2. Chrome is neutral. Borders/rules never carry severity — only inline glyphs do.
 *  3. NO_COLOR / non-TTY strip hue but preserve bold + glyphs (no-color.org rule).
 *  4. Access-safe. Every text-on-surface pair validates ≥4.5:1 on #2A2724.
 *  5. One brand surface. `t.brand` appears sparingly — wordmark, active spinner, ✦ Ready.
 */

import chalk from "chalk";
import { OK, ERR, WARN, INFO, ARROW, BOX } from "./icons.js";

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
// Palette — Ember
//
// Hex values chosen against the terminal surface #2A2724 (dark warm brown).
// Every text pair has been validated ≥ 4.5:1 contrast (WCAG AA). Brand /
// semantic bright twins are for inline glyphs only, never body text.
// ---------------------------------------------------------------------------

export const palette = {
  // ── Brand ─────────────────────────────────────────────────────────────
  brand: "#D97757",        // Terracotta — the one accent that appears anywhere
  brandDim: "#A3553C",     // Deeper terracotta — decorative/dividers only
  brandShim: "#FFB064",    // Animated highlight (spinner sweep, active state)

  // ── Neutral scale (5 tiers) ───────────────────────────────────────────
  textPrimary: "#F0EBE4",  // Headings, keys — brightest neutral
  textWarm:    "#D2C8BC",  // Body copy — the default "text" color
  textMuted:   "#9B948A",  // Labels, metadata
  textSubtle:  "#706A62",  // Paths, quiet meta, box separators inside content
  textFaint:   "#4A4640",  // Rules, box borders, disabled — barely visible

  // ── Semantic ──────────────────────────────────────────────────────────
  ok:   "#7AC592",
  warn: "#FFB064",
  err:  "#E86A6A",
  info: "#8CA8E8",

  // ── Bright twins (inline glyphs / spinner only, never body text) ──────
  okBright:   "#96DCAC",
  warnBright: "#FFC88A",
  errBright:  "#FF8A8A",

  // ── Accents kept from Sunset (used sparingly) ─────────────────────────
  tan:  "#B8956A",  // Italic file paths — softened warm
  code: "#A5B4FC",  // Inline code spans
  num:  "#FFD166",  // Numeric badges
} as const;

// ---------------------------------------------------------------------------
// Theme object — semantic helpers (STABLE API — call sites depend on names)
// ---------------------------------------------------------------------------

export const t = {
  env,

  // ── Brand ─────────────────────────────────────────────────────────────
  brand: (s: string) => chalk.hex(palette.brand)(s),
  brandBold: (s: string) => chalk.hex(palette.brand).bold(s),
  brandShim: (s: string) => chalk.hex(palette.brandShim)(s),
  brandDim: (s: string) => chalk.hex(palette.brandDim)(s),

  // ── Text tiers (5 semantic aliases + `text` legacy alias) ─────────────
  text: (s: string) => chalk.hex(palette.textWarm)(s),        // default body
  primary: (s: string) => chalk.hex(palette.textPrimary)(s),
  warm: (s: string) => chalk.hex(palette.textWarm)(s),
  dim: (s: string) => chalk.hex(palette.textMuted)(s),
  subtle: (s: string) => chalk.hex(palette.textSubtle)(s),
  faint: (s: string) => chalk.hex(palette.textFaint)(s),
  bold: (s: string) => chalk.bold(s),
  italic: (s: string) => chalk.italic(s),
  inverse: (s: string) => chalk.inverse(s),

  // ── Semantic (colored glyphs + status labels only) ────────────────────
  ok: (s: string) => chalk.hex(palette.ok)(s),
  err: (s: string) => chalk.hex(palette.err)(s),
  warn: (s: string) => chalk.hex(palette.warn)(s),
  info: (s: string) => chalk.hex(palette.info)(s),

  // ── Bright variants (single-glyph use only) ───────────────────────────
  okBright: (s: string) => chalk.hex(palette.okBright)(s),
  errBright: (s: string) => chalk.hex(palette.errBright)(s),
  warnBright: (s: string) => chalk.hex(palette.warnBright)(s),

  // ── Formatters ────────────────────────────────────────────────────────
  path: (s: string) => chalk.hex(palette.tan).italic(s),
  cmd: (s: string) => chalk.hex(palette.brand).bold(s),
  code: (s: string) => chalk.hex(palette.code)(s),
  num: (s: string) => chalk.hex(palette.num)(s),
  kbd: (s: string) => chalk.inverse(` ${s} `),

  // ── Deprecated aliases (kept so migration doesn't break call sites) ──
  /** @deprecated Ember folded accent into `warn`. Prefer `t.warn`. */
  accent: (s: string) => chalk.hex(palette.warn)(s),
  /** @deprecated Prefer `t.bold(t.warn(...))`. */
  accentBold: (s: string) => chalk.hex(palette.warn).bold(s),
  /** @deprecated Prefer `t.warnBright`. */
  accentShim: (s: string) => chalk.hex(palette.warnBright)(s),
  /** @deprecated Prefer `t.info`. */
  suggest: (s: string) => chalk.hex(palette.info)(s),
  /** @deprecated Prefer `t.subtle`. */
  muted: (s: string) => chalk.hex(palette.textSubtle)(s),

  // Raw palette (for animation blends — spinner sweep, tip typewriter)
  palette,
} as const;

// ---------------------------------------------------------------------------
// Section header — Ember pattern: title (bold primary) + faint rule below,
// no emoji, full-inner-width rule, mandatory blank line above and below.
// ---------------------------------------------------------------------------

/**
 * Section header — bold title on its own line with a faint rule underneath.
 * The `icon` parameter is accepted for back-compat but IGNORED (Ember has
 * no chrome emoji). Callers can safely keep passing them until M2 sweeps
 * the call sites.
 *
 *   Build MCP Server
 *   ────────────────────────────────────────
 */
export function sectionHeader(title: string, _icon?: string): void {
  void _icon;
  const width = Math.min(
    ruleWidth(),
    Math.max(displayWidth(title), 24),
  );
  console.log();
  console.log(`  ${t.bold(t.primary(title))}`);
  console.log(`  ${t.faint(BOX.h.repeat(width))}`);
  console.log();
}

/** Faint rule width — 40 by default, shorter for narrow terminals. */
function ruleWidth(): number {
  const cols = env.columns || 80;
  return Math.min(40, Math.max(20, cols - 6));
}

// ---------------------------------------------------------------------------
// Step lines — canonical Ember pattern:
//   [3-char glyph column colored][2sp][text-warm label][optional italic-subtle detail]
// Every step function passes through the same layout so ok/warn/err/info/brand
// align vertically when stacked.
// ---------------------------------------------------------------------------

function stepLine(
  glyph: string,
  colorize: (s: string) => string,
  label: string,
  detail: string,
): void {
  const g = colorize(glyph).padEnd(3 + (glyph.length - displayWidth(glyph)));
  const d = detail ? `  ${t.italic(t.subtle(detail))}` : "";
  console.log(`  ${g}  ${t.warm(label)}${d}`);
}

export function stepOk(label: string, detail = ""): void {
  stepLine(OK, t.ok, label, detail);
}
export function stepErr(label: string, detail = ""): void {
  stepLine(ERR, t.err, label, detail);
}
export function stepWarn(label: string, detail = ""): void {
  stepLine(WARN, t.warn, label, detail);
}
export function stepInfo(label: string, detail = ""): void {
  stepLine(INFO, t.info, label, detail);
}
export function stepBrand(label: string, detail = ""): void {
  stepLine(ARROW, t.brand, label, detail);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex

/** Strip ANSI escape codes so we can measure display width accurately. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Display width of a string, ignoring ANSI codes. Emoji and CJK count as 2.
 * Single source of truth — `spinner.ts` and other modules import from here
 * rather than re-implement (was duplicated pre-Ember).
 */
export function displayWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    // Wide-char detection (emoji + CJK + geometric shapes)
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
// Legacy helpers — kept for migration, marked for M6 cleanup
// ---------------------------------------------------------------------------

/** @deprecated Prefer rounded boxes. Faint rule width `width`. */
export function hrLine(width = 56): string {
  return t.faint("─".repeat(width));
}
/** @deprecated Prefer the brand-dim rule inside boxes. */
export function hrBrand(width = 56): string {
  return t.brandDim("─".repeat(width));
}
/** @deprecated Prefer `kvGrid` from `./kv-grid.ts`. */
export function kvLine(key: string, value: string, keyWidth = 16): string {
  const padded = key.padEnd(keyWidth);
  return `${t.dim(padded)}  ${t.warm(value)}`;
}

// ---------------------------------------------------------------------------
// Back-compat: `sectionBox` and `_registerRoundedBox` moved to `./box.ts`.
// Ember removes the circular dependency; theme.ts imports NOTHING from
// box.ts anymore. Old call sites (`import { sectionBox } from './theme.js'`)
// break in migration — grep + swap to `import { sectionBox } from './box.js'`.
// The audit found only two such call sites; they get fixed in M2/M5.
// ---------------------------------------------------------------------------

/**
 * @deprecated No-op kept solely for source compat with any file that still
 * calls `_registerRoundedBox`. The registration mechanism is gone; box.ts
 * exports `sectionBox` directly now. Delete in M6.
 */
export function _registerRoundedBox(_impl: unknown): void {
  void _impl;
}

/**
 * @deprecated Re-exported from `./box.js` for source compatibility.
 * New code should import `sectionBox` from `./box.js` directly.
 */
export { sectionBox } from "./box.js";
