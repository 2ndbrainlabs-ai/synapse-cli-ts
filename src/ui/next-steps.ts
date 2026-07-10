/**
 * Numbered next-steps helper — the "what to do next" list at the end of a
 * successful command.
 *
 *   Next steps:
 *     1. Review the generated server code
 *     2. pip install mcp
 *     3. python mcp_server.py
 */

import { t } from "./theme.js";

export interface StepItem {
  /** Plain text describing the step. */
  text: string;
  /** Optional command to show in `t.cmd` styling after the text. */
  cmd?: string;
}

/**
 * Render a numbered next-steps block as an array of pre-styled lines.
 * Callers pass this into `roundedBox` or print directly.
 */
export function nextSteps(items: (string | StepItem)[]): string[] {
  const lines: string[] = [];
  lines.push(t.dim("Next steps:"));
  for (let i = 0; i < items.length; i++) {
    const num = t.num(`${i + 1}.`);
    const item = items[i];
    if (typeof item === "string") {
      lines.push(`  ${num} ${t.text(item)}`);
    } else if (item.cmd) {
      const prefix = item.text ? `${t.text(item.text)}  ` : "";
      lines.push(`  ${num} ${prefix}${t.cmd(item.cmd)}`);
    } else {
      lines.push(`  ${num} ${t.text(item.text)}`);
    }
  }
  return lines;
}
