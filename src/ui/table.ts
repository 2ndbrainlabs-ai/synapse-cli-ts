/**
 * Ember responsive table.
 *
 * Renders a real aligned table at medium+ terminals, degrades to a stacked
 * "records" list at narrow terminals so nothing overflows. All strings are
 * measured via `displayWidth` — ANSI-safe.
 *
 * Not a general grid — good enough for `synapse logs --list` and similar
 * short summary displays.
 */

import { t, displayWidth, stripAnsi } from "./theme.js";
import { breakpoint, cols } from "./layout.js";

export interface Column<Row> {
  header: string;
  /** Extract the cell value for this row. Return an already-formatted string. */
  get: (row: Row) => string;
  /** Optional min-width; column may grow beyond this to fit content. */
  minWidth?: number;
}

export interface TableOpts {
  /** Force stacked-record rendering regardless of breakpoint. */
  stacked?: boolean;
  /** Character used between rows in narrow mode. Default: faint horizontal rule. */
  narrowRuleWidth?: number;
}

export function renderTable<Row>(
  rows: Row[],
  columns: Column<Row>[],
  opts: TableOpts = {},
): void {
  if (rows.length === 0) return;

  const bp = breakpoint();
  if (opts.stacked || bp === "narrow") {
    renderStacked(rows, columns, opts.narrowRuleWidth ?? Math.min(40, cols() - 4));
    return;
  }

  // Compute column widths — max(headerWidth, max cell width, minWidth).
  const widths: number[] = columns.map((col, i) => {
    const cellMax = Math.max(
      displayWidth(col.header),
      ...rows.map((r) => displayWidth(columns[i].get(r))),
    );
    return Math.max(col.minWidth ?? 0, cellMax);
  });

  // Header row — bold text-primary, no glyph before.
  const headerCells = columns.map((c, i) => t.bold(t.primary(pad(c.header, widths[i]))));
  console.log("  " + headerCells.join("  "));

  // Faint horizontal rule beneath the header.
  const ruleWidth = widths.reduce((a, w) => a + w, 0) + (widths.length - 1) * 2;
  console.log("  " + t.faint("─".repeat(Math.min(ruleWidth, cols() - 4))));

  // Body rows.
  for (const r of rows) {
    const cells = columns.map((c, i) => pad(c.get(r), widths[i]));
    console.log("  " + cells.join("  "));
  }
}

// ---------------------------------------------------------------------------
// Stacked-record fallback (narrow terminals + `stacked: true`)
// ---------------------------------------------------------------------------

function renderStacked<Row>(
  rows: Row[],
  columns: Column<Row>[],
  ruleWidth: number,
): void {
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) console.log("  " + t.faint("─".repeat(ruleWidth)));
    for (const c of columns) {
      const label = t.bold(pad(c.header, 12));
      const value = c.get(rows[i]);
      console.log(`  ${label} ${t.warm(value)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Padding helper — pads plain-string display width, ANSI safe.
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  const plain = stripAnsi(s);
  const w = displayWidth(plain);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}
