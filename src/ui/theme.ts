import chalk from "chalk";

// ---------------------------------------------------------------------------
// Color palette — warm terracotta accent on neutral grays
// ---------------------------------------------------------------------------

// Brand gradient: terracotta → warm orange
const BRAND_PRIMARY = chalk.hex("#d97757");
const BRAND_SECONDARY = chalk.hex("#c6613f");
const BRAND_GLOW = chalk.hex("#e8956a");

// Neutrals
const TEXT = chalk.hex("#e8e6df");
const DIM = chalk.hex("#73726c");
const MUTED = chalk.hex("#9c9b95");
const SURFACE = chalk.hex("#3d3d3a");

// Semantic
const SUCCESS = chalk.hex("#4ade80");
const ERROR = chalk.hex("#f87171");
const WARN = chalk.hex("#fbbf24");
const INFO = chalk.hex("#60a5fa");

// Emphasis
const BOLD_TEXT = chalk.bold.hex("#e8e6df");
const BOLD_BRAND = chalk.bold.hex("#d97757");

export const t = {
  brand: BRAND_PRIMARY,
  brandBold: BOLD_BRAND,
  brandDim: BRAND_SECONDARY,
  brandGlow: BRAND_GLOW,

  text: TEXT,
  dim: DIM,
  muted: MUTED,
  surface: SURFACE,
  bold: BOLD_TEXT,

  ok: SUCCESS,
  err: ERROR,
  warn: WARN,
  info: INFO,

  label: (s: string) => DIM(s),
  value: (s: string) => TEXT(s),
  path: (s: string) => chalk.underline.hex("#60a5fa")(s),
  cmd: (s: string) => chalk.hex("#d97757").bold(s),
  code: (s: string) => chalk.hex("#a5b4fc")(s),
  num: (s: string) => chalk.hex("#fbbf24")(s),
};

// ---------------------------------------------------------------------------
// Box-drawing primitives
// ---------------------------------------------------------------------------

const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│", dot: "·",
};

export function hrLine(width = 56): string {
  return t.dim(BOX.h.repeat(width));
}

export function hrBrand(width = 56): string {
  return t.brandDim(BOX.h.repeat(width));
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

export function sectionHeader(title: string): void {
  console.log();
  console.log(`  ${t.brandBold(title)}`);
  console.log(`  ${hrBrand(title.length + 6)}`);
}

export function sectionBox(
  title: string,
  color: "brand" | "ok" | "err" | "warn" | "info",
  lines: string[],
): void {
  const c = color === "brand" ? t.brand
    : color === "ok" ? t.ok
    : color === "err" ? t.err
    : color === "warn" ? t.warn
    : t.info;

  console.log();
  console.log(`  ${c(title)}`);
  console.log(`  ${c(BOX.h.repeat(title.length + 2))}`);
  for (const line of lines) {
    if (line === "") {
      console.log();
    } else {
      console.log(`  ${line}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Step indicators
// ---------------------------------------------------------------------------

export function stepOk(label: string, detail = ""): void {
  const suffix = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.ok("✓")}  ${label}${suffix}`);
}

export function stepErr(label: string, detail = ""): void {
  const suffix = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.err("✗")}  ${label}${suffix}`);
}

export function stepWarn(label: string, detail = ""): void {
  const suffix = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.warn("!")}  ${label}${suffix}`);
}

export function stepInfo(label: string, detail = ""): void {
  const suffix = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.info(">")}  ${label}${suffix}`);
}

export function stepBrand(label: string, detail = ""): void {
  const suffix = detail ? `  ${t.dim(detail)}` : "";
  console.log(`  ${t.brand(">")}  ${label}${suffix}`);
}

// ---------------------------------------------------------------------------
// Key-value pairs for status/config
// ---------------------------------------------------------------------------

export function kvLine(key: string, value: string, keyWidth = 16): void {
  const padded = key.padEnd(keyWidth);
  console.log(`  ${t.dim(padded)} ${t.text(value)}`);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export { BOX, stripAnsi };
