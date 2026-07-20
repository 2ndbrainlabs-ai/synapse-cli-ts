/**
 * Key/value grid — used for stats blocks, config listings, info sections.
 *
 * Renders aligned pairs with dim keys and text values. Optionally right-aligns
 * numeric values (like Python's Rich version).
 *
 *   Directories        4
 *   Python Files      28
 *   Lines          6,341
 */

import { t, displayWidth } from "./theme.js";
import { BOX } from "./icons.js";

export interface KvRow {
  key: string;
  value: string;
  /** If true, render value with `t.num` for numeric emphasis. */
  numeric?: boolean;
  /** Optional leading icon (emoji or glyph). */
  icon?: string;
}

export interface KvGridOpts {
  /** Minimum key column width. Default 16. */
  keyWidth?: number;
  /** Indent from left. Default 2 spaces. */
  indent?: string;
  /** Right-align values numerically. Default false. */
  rightAlignValues?: boolean;
  /**
   * Optional section title printed above the grid with a thin underline.
   * Groups related stat blocks visually (e.g. "Project" or "Account Quota").
   */
  title?: string;
}

export function kvGrid(rows: KvRow[], opts: KvGridOpts = {}): void {
  const ind = opts.indent ?? "  ";
  if (opts.title) {
    console.log(`${ind}${t.bold(t.dim(opts.title))}`);
    console.log(`${ind}${t.subtle(BOX.h.repeat(opts.title.length))}`);
    console.log();
  }

  const { keyWidth = 16, indent = "  ", rightAlignValues = false } = opts;

  // Compute actual key column width from rows
  const maxKey = Math.max(
    keyWidth,
    ...rows.map((r) => displayWidth(r.icon ? `${r.icon}  ${r.key}` : r.key) + 2),
  );

  const maxValue = rightAlignValues
    ? Math.max(...rows.map((r) => displayWidth(r.value)))
    : 0;

  for (const row of rows) {
    const keyLabel = row.icon ? `${row.icon}  ${row.key}` : row.key;
    const keyText = t.dim(keyLabel);
    const keyPad = " ".repeat(Math.max(1, maxKey - displayWidth(keyLabel)));

    let valueText: string;
    if (row.numeric) valueText = t.num(row.value);
    else valueText = t.text(row.value);

    let valuePart: string;
    if (rightAlignValues) {
      const pad = " ".repeat(Math.max(0, maxValue - displayWidth(row.value)));
      valuePart = pad + valueText;
    } else {
      valuePart = valueText;
    }

    console.log(`${indent}${keyText}${keyPad}${valuePart}`);
  }
}
