/**
 * Icon vocabulary — single source of truth.
 *
 * Every glyph the CLI uses lives here. Ember pattern: no chrome emoji,
 * one sanctioned `SPARK` for the "Ready" completion line, ASCII-safe
 * fallbacks reserved for the `!isUnicodeSupported()` path (added in M6).
 */

// ── Status glyphs (Ember canonical set) ───────────────────────────────────
export const OK = "✓";
export const ERR = "✗";       // changed from ✖ — cleaner form, matches @clack, Bun
export const WARN = "!";      // exclamation mark — punchier than ⚠, no width flex
export const INFO = "i";      // lowercase i — sits below the type baseline nicely

// ── Directional / structural ──────────────────────────────────────────────
export const ARROW = "›";       // Prompt marker, breadcrumbs
export const ARROW_R = "→";     // Next-step CTA
export const BULLET = "•";
export const DOT = "·";
export const DOT_FILLED = "●";
export const CIRCLE = "○";
export const DIAMOND = "◆";     // Active prompt anchor
export const SPARK = "✦";       // The one and only "Ready" completion glyph

// ── File-type single letters (Available Code listings) ────────────────────
export const FN = "f";
export const CLS = "C";

// ── Rounded box glyphs ────────────────────────────────────────────────────
export const BOX = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
} as const;

// ── Dashed variant (used for in-progress / tip boxes) ─────────────────────
export const BOX_DASHED = {
  ...BOX,
  h: "╌",
} as const;

// ── Spinner frames — single Ember mode: Braille dots @ 80ms ───────────────
export const BRAILLE_FRAMES = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const;

// ── Confidence bars (rendered by pickers, never as numbers) ───────────────
export const CONF_BAR = {
  high: "━━━",
  med:  "━━─",
  low:  "━──",
} as const;

// ── Progress bar cells (Bun / Turborepo idiom) ────────────────────────────
export const PROGRESS_FULL = "━";
export const PROGRESS_EMPTY = "─";

// ── Deprecated (kept as shims so no import breaks during migration) ───────
/** @deprecated Ember uses `SPARK` (✦) instead. */
export const STAR = "✦";
/** @deprecated The orbital spinner is retired; use Braille. Kept for compat. */
export const ORBITAL_FRAMES = ["╭╯", "╮╰", "╯╭", "╰╮"] as const;

/**
 * @deprecated Ember has no chrome emoji. This map returns empty strings so
 * `${EMOJI.build}  Title` still parses but renders as ${title}. Delete in M6.
 */
export const EMOJI = {
  build: "",
  analyze: "",
  info: "",
  config: "",
  init: "",
  folder: "",
  file: "",
  pkg: "",
  spark: SPARK,
  wrench: "",
} as const;
