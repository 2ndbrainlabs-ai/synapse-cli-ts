/**
 * Content block primitives — border-free, width-adaptive layout.
 *
 * Replaces the old `╭─╮│╰─╯` rectangular panels with:
 *   roundedBox → header + rule + indented body (adapts to any terminal width)
 *   dashedBox  → full-width label rule + content + closing rule
 *
 * Both functions keep their original signatures so all callers work unchanged.
 */

import { t, stripAnsi, displayWidth, _registerRoundedBox } from "./theme.js";
import { BOX } from "./icons.js";

const INDENT = "  ";

interface RoundedBoxOpts {
  /** Wrap long lines to fit content width. Default true. */
  wrap?: boolean;
}

/**
 * Draw a border-free content block: bold header + rule + indented body.
 *
 * ```
 *   ✓  MCP Server Generated
 *   ──────────────────────────────
 *
 *      Tools:     2
 *      Resources: 0
 *      Output:    mcp_server.py
 *
 * ```
 *
 * The rule width scales with the header text (never fixed). Body is indented
 * 5 spaces and wraps at `cols - 5`. Adapts to any terminal width.
 *
 * @param title  Title rendered bold in `color`
 * @param icon   Optional leading glyph / emoji
 * @param color  Status colorizer (e.g. `t.ok`, `t.err`, `t.brand`)
 * @param lines  Body lines. Empty strings render as blank separator rows.
 * @param opts   Rendering options
 */
export function roundedBox(
  title: string,
  icon: string | undefined,
  color: (s: string) => string,
  lines: string[],
  opts: RoundedBoxOpts = {},
): void {
  const { wrap = true } = opts;
  const headerText = icon ? `${icon}  ${title}` : title;
  const cols = Math.max(24, (t.env.columns || 80) - 4);

  // Rule: a bit longer than the header but never overflows the terminal
  const headerW = displayWidth(stripAnsi(headerText));
  const ruleWidth = Math.min(cols, Math.max(headerW + 4, 28));

  // Header in status color (bold), followed by a rule in the same color
  console.log();
  console.log(`${INDENT}${color(t.bold(headerText))}`);
  console.log(`${INDENT}${color(BOX.h.repeat(ruleWidth))}`);

  // Body: blank line + 5-space indented content + trailing blank line
  if (lines.length > 0) {
    const wrapWidth = cols - 5;
    console.log();
    for (const line of lines) {
      if (line === "") {
        console.log();
        continue;
      }
      const bodyLines = wrap ? wrapLine(line, wrapWidth) : [line];
      for (const l of bodyLines) {
        // Auto-cream for plain strings; ANSI-colored strings pass through
        const rendered = stripAnsi(l) === l ? t.warm(l) : l;
        console.log(`     ${rendered}`);
      }
    }
  }
  console.log();
}

/**
 * Draw a full-width label rule + content block + closing rule.
 *
 * ```
 *   ─── MCP Client Config ──────────────────────────────────────────────
 *
 *   {
 *     "mcpServers": { ... }
 *   }
 *
 *   ─────────────────────────────────────────────────────────────────────
 *
 * ```
 *
 * The title floats in the opening rule. Content has 2-space indent (copy-paste
 * friendly for JSON / code). Both rules span the full terminal width.
 *
 * @param title  Label shown in the opening rule
 * @param _color Signature-compat parameter (unused — layout is always subtle/dim)
 * @param lines  Content lines
 */
export function dashedBox(
  title: string,
  _color: (s: string) => string,
  lines: string[],
): void {
  const cols = Math.max(24, (t.env.columns || 80) - 4);

  // Opening rule with floating label: "─── Title ─────────────────────────"
  const label = ` ${title} `;
  const leftDashes = 3;
  const rightDashes = Math.max(0, cols - leftDashes - label.length);

  console.log();
  console.log(
    `${INDENT}${t.brand(BOX.h.repeat(leftDashes))}${t.brandBold(label)}${t.subtle(BOX.h.repeat(rightDashes))}`,
  );
  console.log();

  // Content — no extra indent so code/JSON is easy to copy-paste
  for (const line of lines) {
    if (line === "") {
      console.log();
      continue;
    }
    // Pre-colored lines pass through; plain lines get warm cream
    const rendered = stripAnsi(line) === line ? t.warm(line) : line;
    console.log(`${INDENT}${rendered}`);
  }

  // Closing rule — 3 brand dashes then subtle fade (mirrors opening accent)
  console.log();
  console.log(`${INDENT}${t.brand(BOX.h.repeat(leftDashes))}${t.subtle(BOX.h.repeat(cols - leftDashes))}`);
  console.log();
}

/**
 * Wrap a single logical line to fit within maxWidth (in display columns).
 * ANSI-safe: colors are re-applied per segment by convention.
 */
function wrapLine(line: string, maxWidth: number): string[] {
  const plain = stripAnsi(line);
  if (plain.length <= maxWidth) return [line];

  if (plain === line) {
    // No ANSI — plain word-wrap
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

  // Has ANSI — naïve whitespace split (may lose some formatting on wrap)
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

// Register with theme.ts for the legacy `sectionBox` wrapper
_registerRoundedBox(roundedBox);
