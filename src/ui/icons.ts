/**
 * Icon vocabulary — single source of truth.
 *
 * Every glyph the CLI uses lives here so we never drift between ✖ vs ✗ or
 * reuse the same character for different meanings.
 */

// Status
export const OK = "✓";
export const ERR = "✖";
export const WARN = "⚠";
export const INFO = "ⓘ";

// Directional / structural
export const ARROW = "›";
export const ARROW_R = "→";
export const BULLET = "•";
export const DOT = "·";
export const DOT_FILLED = "●";
export const CIRCLE = "○";
export const STAR = "★";
export const SPARK = "⚡";

// File-type single letters (used in Available Code listings)
export const FN = "f";
export const CLS = "C";

// Rounded box glyphs
export const BOX = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
} as const;

// Orbital spinner frames — the Synapse signature (matches Python CLI)
export const ORBITAL_FRAMES = ["╭╯", "╮╰", "╯╭", "╰╮"] as const;

// Braille spinner — used for tool-call-heavy phases
export const BRAILLE_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

// Command headers use emoji — keep the set minimal & consistent
export const EMOJI = {
  build: "🏗️",
  analyze: "🔍",
  info: "📊",
  config: "⚙️",
  init: "🎉",
  folder: "📁",
  file: "📄",
  pkg: "📦",
  spark: "⚡",
  wrench: "🔧",
} as const;
