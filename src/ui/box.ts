/**
 * Rounded content boxes — the Ember content panel.
 *
 * Ember principle: the box border itself carries NO semantic color. Only
 * the inline status glyph inside the header row is colored. That way the
 * eye lands on the accent word/glyph, not the whole frame.
 *
 * Two public entry points:
 *
 *  1. `roundedBox(title, icon, color, lines)` — legacy 4-arg form. The
 *     `color` argument is now used only for the header GLYPH; the border
 *     is always `t.faint`.
 *
 *  2. `roundedBox({ body, innerWidth, borderColor?, variant?, title?, ... })`
 *     — new options form. Preferred in new code. `variant: "dashed"`
 *     replaces the retired `dashedBox()` helper (kept as a passthrough).
 */

import { t, stripAnsi, displayWidth } from "./theme.js";
import { BOX, BOX_DASHED } from "./icons.js";
import { boxInnerWidth } from "./layout.js";

const INDENT = "  ";
const H_PAD = 2;
const MIN_INNER = 28;

// Semantic color to inline-glyph mapping. Everything else uses text-faint.
type Colorizer = (s: string) => string;

interface RoundedBoxOptions {
  /** Body lines. Empty strings render blank rows. Required (options form). */
  body?: string[];
  /** Title shown in the header row. */
  title?: string;
  /** Optional glyph placed before the title. Colored via `glyphColor`. */
  glyph?: string;
  /** Color applied to the title's leading glyph. Default: none (title-primary). */
  glyphColor?: Colorizer;
  /** Force a specific inner width. Default: from `boxInnerWidth()`. */
  innerWidth?: number;
  /** Border color. Default: `t.faint`. Do not pass a semantic color here. */
  borderColor?: Colorizer;
  /** "solid" (default) or "dashed" (in-progress / tip box). */
  variant?: "solid" | "dashed";
  /** Word-wrap body lines longer than innerWidth. Default true. */
  wrap?: boolean;
}

interface LegacyOpts {
  wrap?: boolean;
}

// ---------------------------------------------------------------------------
// Public entry point — accepts either the legacy 4-arg form or the new
// options-object form. Dispatch on typeof first arg.
// ---------------------------------------------------------------------------

export function roundedBox(opts: RoundedBoxOptions): void;
export function roundedBox(
  title: string,
  icon: string | undefined,
  color: Colorizer,
  lines: string[],
  opts?: LegacyOpts,
): void;
export function roundedBox(
  first: RoundedBoxOptions | string,
  icon?: string,
  color?: Colorizer,
  lines?: string[],
  legacyOpts?: LegacyOpts,
): void {
  if (typeof first === "string") {
    return renderBox({
      title: first,
      glyph: icon,
      glyphColor: color,
      borderColor: t.faint,
      body: lines ?? [],
      variant: "solid",
      wrap: legacyOpts?.wrap ?? true,
    });
  }
  return renderBox({
    variant: "solid",
    wrap: true,
    borderColor: t.faint,
    ...first,
  });
}

/**
 * @deprecated Use `roundedBox({ variant: "dashed", ... })`. Kept as a
 * passthrough so no import breaks; deleted in M6.
 */
export function dashedBox(title: string, color: Colorizer, lines: string[]): void {
  renderBox({
    title,
    glyphColor: color,
    borderColor: t.faint,
    body: lines,
    variant: "dashed",
    wrap: true,
  });
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderBox(opts: RoundedBoxOptions): void {
  const wrap = opts.wrap ?? true;
  const border = opts.borderColor ?? t.faint;
  const glyphColor = opts.glyphColor ?? t.warm;
  const chars = opts.variant === "dashed" ? BOX_DASHED : BOX;

  // Compose header text — glyph is colored, title is bold primary.
  const glyphPart = opts.glyph
    ? `${glyphColor(opts.glyph)}  `
    : "";
  const titlePart = opts.title ? t.bold(t.primary(opts.title)) : "";
  const headerText = opts.title ? `${glyphPart}${titlePart}` : "";

  // Body pre-processing
  const rawBody = opts.body ?? [];
  const maxRawWidth = Math.max(
    displayWidth(stripAnsi(headerText)),
    ...rawBody.map((l) => displayWidth(l)),
  );

  const boxMax = opts.innerWidth ?? boxInnerWidth();
  const targetInner = Math.max(
    MIN_INNER,
    Math.min(boxMax, maxRawWidth || boxMax),
  );

  const bodyLines: string[] = [];
  for (const line of rawBody) {
    if (line === "") {
      bodyLines.push("");
      continue;
    }
    if (wrap) bodyLines.push(...wrapLine(line, targetInner));
    else bodyLines.push(line);
  }

  const innerWidth = Math.max(
    displayWidth(stripAnsi(headerText)),
    ...bodyLines.map((l) => displayWidth(l)),
    targetInner,
  );
  const totalInner = innerWidth + H_PAD * 2;

  // ── Top border ──────────────────────────────────────────────────────
  console.log(INDENT + border(chars.tl + chars.h.repeat(totalInner) + chars.tr));

  // ── Header row (if title provided) ──────────────────────────────────
  if (headerText) {
    const headerWidth = displayWidth(stripAnsi(headerText));
    console.log(
      INDENT +
        border(chars.v) +
        " ".repeat(H_PAD) +
        headerText +
        " ".repeat(Math.max(0, totalInner - H_PAD - headerWidth)) +
        border(chars.v),
    );
    // Blank separator row after the title (only if there's body content).
    if (bodyLines.length > 0) {
      console.log(
        INDENT +
          border(chars.v) +
          " ".repeat(totalInner) +
          border(chars.v),
      );
    }
  }

  // ── Body rows ───────────────────────────────────────────────────────
  for (const line of bodyLines) {
    const w = displayWidth(line);
    const pad = Math.max(0, totalInner - H_PAD - w);
    console.log(
      INDENT +
        border(chars.v) +
        " ".repeat(H_PAD) +
        line +
        " ".repeat(pad) +
        border(chars.v),
    );
  }

  // ── Bottom border ───────────────────────────────────────────────────
  console.log(INDENT + border(chars.bl + chars.h.repeat(totalInner) + chars.br));
}

// ---------------------------------------------------------------------------
// Word-wrap helper (ANSI-aware, imperfect but safe for our usage)
// ---------------------------------------------------------------------------

function wrapLine(line: string, maxWidth: number): string[] {
  const plain = stripAnsi(line);
  if (plain.length <= maxWidth) return [line];

  // Line has no ANSI codes — plain wrapping works.
  if (plain === line) {
    const out: string[] = [];
    const words = line.split(/(\s+)/);
    let current = "";
    for (const word of words) {
      if (displayWidth(current + word) > maxWidth && current) {
        out.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current += word;
      }
    }
    if (current) out.push(current);
    return out;
  }

  // Has ANSI — split on whitespace. Colors reapplied per-token by convention.
  const out: string[] = [];
  const tokens = line.split(/\s+/);
  let current = "";
  for (const tok of tokens) {
    const candidate = current ? `${current} ${tok}` : tok;
    if (displayWidth(candidate) > maxWidth && current) {
      out.push(current);
      current = tok;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// Back-compat: `sectionBox` — variant-colored glyph in a rounded box.
// Old call sites imported from theme.ts; that import still works via the
// `export { sectionBox } from "./box.js"` shim in theme.ts. New code should
// call `roundedBox({ glyph, glyphColor: t.err, ... })` directly.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `roundedBox({ glyph, glyphColor: t.err, ... })` directly.
 */
export function sectionBox(
  title: string,
  variant: "ok" | "err" | "warn" | "info",
  lines: string[],
): void {
  const color =
    variant === "ok" ? t.ok
    : variant === "err" ? t.err
    : variant === "warn" ? t.warn
    : t.info;
  renderBox({
    title,
    glyphColor: color,
    borderColor: t.faint,
    body: lines,
    variant: "solid",
    wrap: true,
  });
}
