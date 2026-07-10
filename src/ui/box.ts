/**
 * Rounded box primitives — the Synapse content panel.
 *
 * Draws real rounded borders `╭─╮ │ ╰─╯` sized to fit the content (not the
 * terminal width). Used for success/error blocks, welcome message, PRO TIP.
 */

import { t, stripAnsi, displayWidth, _registerRoundedBox } from "./theme.js";
import { BOX } from "./icons.js";

const INDENT = "  ";
const H_PAD = 2; // padding inside the box on each side
const MIN_INNER = 32;
const MAX_INNER = 76;

interface RoundedBoxOpts {
  /** Wrap long lines to fit inside the box. Default true. */
  wrap?: boolean;
}

/**
 * Draw a rounded content-sized box.
 *
 * ```
 *   ╭──────────────────────╮
 *   │  🎉  Welcome         │
 *   │                      │
 *   │  Line 1              │
 *   │  Line 2              │
 *   ╰──────────────────────╯
 * ```
 *
 * @param title    Title shown at the top (rendered bold in `color`)
 * @param icon     Optional leading icon (emoji or single glyph)
 * @param color    Colorizer for the border + title (e.g. `t.ok`, `t.brand`)
 * @param lines    Body lines. Empty strings render as blank rows for grouping.
 * @param opts     Rendering options
 */
export function roundedBox(
  title: string,
  icon: string | undefined,
  color: (s: string) => string,
  lines: string[],
  opts: RoundedBoxOpts = {},
): void {
  const { wrap = true } = opts;

  // Compose header text (with icon if provided)
  const headerText = icon ? `${icon}  ${title}` : title;

  // Determine target inner width
  const maxLineWidth = Math.max(
    displayWidth(headerText),
    ...lines.map((l) => displayWidth(l)),
  );
  const termLimit = Math.max(MIN_INNER, (t.env.columns || 80) - 6);
  const targetInner = Math.min(
    MAX_INNER,
    Math.max(MIN_INNER, Math.min(maxLineWidth, termLimit)),
  );

  // Wrap or truncate lines to targetInner
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (line === "") {
      bodyLines.push("");
      continue;
    }
    if (wrap) bodyLines.push(...wrapLine(line, targetInner));
    else bodyLines.push(line);
  }

  // Actual inner width (may equal or slightly exceed target if wrap:false)
  const innerWidth = Math.max(
    displayWidth(headerText),
    ...bodyLines.map((l) => displayWidth(l)),
    targetInner,
  );
  const totalInner = innerWidth + H_PAD * 2;

  // Top border
  console.log(
    INDENT + color(BOX.tl + BOX.h.repeat(totalInner) + BOX.tr),
  );

  // Header row
  console.log(
    INDENT +
      color(BOX.v) +
      " ".repeat(H_PAD) +
      color(t.bold(headerText)) +
      " ".repeat(totalInner - H_PAD - displayWidth(headerText)) +
      color(BOX.v),
  );

  // Separator blank line after title
  if (bodyLines.length > 0) {
    console.log(
      INDENT +
        color(BOX.v) +
        " ".repeat(totalInner) +
        color(BOX.v),
    );
  }

  // Body rows
  for (const line of bodyLines) {
    const w = displayWidth(line);
    const pad = Math.max(0, totalInner - H_PAD - w);
    console.log(
      INDENT +
        color(BOX.v) +
        " ".repeat(H_PAD) +
        line +
        " ".repeat(pad) +
        color(BOX.v),
    );
  }

  // Bottom border
  console.log(
    INDENT + color(BOX.bl + BOX.h.repeat(totalInner) + BOX.br),
  );
}

/**
 * Wrap a single logical line to fit within maxWidth (in display columns).
 * ANSI-safe: preserves color codes across the wrap boundary imperfectly
 * (colors are re-applied per segment by convention — callers pre-color spans).
 */
function wrapLine(line: string, maxWidth: number): string[] {
  const plain = stripAnsi(line);
  if (plain.length <= maxWidth) return [line];

  // If line has no ANSI codes, plain wrapping works
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

  // Has ANSI — split by whitespace naïvely, may lose some formatting on wrap
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

/**
 * Simpler helper: draw a "dashed" box using thin dashes — for in-progress states.
 * Same layout as roundedBox but uses `╌` for horizontal borders.
 */
export function dashedBox(
  title: string,
  color: (s: string) => string,
  lines: string[],
): void {
  const originalH = BOX.h;
  // Temporarily swap horizontal glyph — safe since BOX is not frozen elsewhere
  // Actually let's just render inline
  const headerText = title;
  const maxLineWidth = Math.max(
    displayWidth(headerText),
    ...lines.map((l) => displayWidth(l)),
  );
  const targetInner = Math.min(
    MAX_INNER,
    Math.max(MIN_INNER, maxLineWidth),
  );
  const totalInner = targetInner + H_PAD * 2;
  const dash = "╌";

  console.log(INDENT + color(BOX.tl + dash.repeat(totalInner) + BOX.tr));
  console.log(
    INDENT +
      color(BOX.v) +
      " ".repeat(H_PAD) +
      color(t.bold(headerText)) +
      " ".repeat(totalInner - H_PAD - displayWidth(headerText)) +
      color(BOX.v),
  );
  if (lines.length > 0) {
    console.log(INDENT + color(BOX.v) + " ".repeat(totalInner) + color(BOX.v));
    for (const line of lines) {
      const pad = Math.max(0, totalInner - H_PAD - displayWidth(line));
      console.log(
        INDENT + color(BOX.v) + " ".repeat(H_PAD) + line + " ".repeat(pad) + color(BOX.v),
      );
    }
  }
  console.log(INDENT + color(BOX.bl + dash.repeat(totalInner) + BOX.br));
  void originalH;
}
