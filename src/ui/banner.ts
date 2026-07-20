/**
 * Startup banner + welcome box.
 *
 * SYNAPS3 ASCII logo — flame gradient from dark warm brown to brand terracotta
 * peak and back, with the "3" glyph in bold gold accent on every row.
 */

import chalk from "chalk";
import { t, sectionHeader } from "./theme.js";
import { roundedBox } from "./box.js";

// Flame gradient: dark warm brown → brand terracotta peak → dark warm brown
// One color per row (6 rows total), mirrored around the peak at row 3.
const BANNER_GRADIENT = [
  "#6b5e56",  // row 0 — muted warm brown, barely visible
  "#a07060",  // row 1 — warm mid-brown
  "#cc7a5a",  // row 2 — approaching brand terracotta
  "#d97757",  // row 3 — BRAND PEAK (full terracotta)
  "#cc7a5a",  // row 4 — receding
  "#a07060",  // row 5 — fades out
] as const;

// ASCII logo — kept as-is for brand recognition, gradient applied at render time.
const LOGO_LINES = [
  "███████╗██╗   ██╗███╗   ██╗ █████╗ ██████╗ ███████╗██████╗ ",
  "██╔════╝╚██╗ ██╔╝████╗  ██║██╔══██╗██╔══██╗██╔════╝╚════██╗",
  "███████╗ ╚████╔╝ ██╔██╗ ██║███████║██████╔╝███████╗ █████╔╝",
  "╚════██║  ╚██╔╝  ██║╚██╗██║██╔══██║██╔═══╝ ╚════██║╚════██╗",
  "███████║   ██║   ██║ ╚████║██║  ██║██║     ███████║██████╔╝",
  "╚══════╝   ╚═╝   ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═════╝ ",
];

/**
 * Show the SYNAPS3 logo + tagline. Called only by `init` (Python parity).
 *
 * Each row of the block-font logo is colorized with a flame gradient
 * (dark warm brown → brand terracotta → dark warm brown). The "3" glyph
 * (last 8 chars of each row) is rendered in bold gold accent on every row,
 * making it pop against the gradient body.
 */
export function displayBanner(): void {
  console.log();
  for (let i = 0; i < LOGO_LINES.length; i++) {
    const line = LOGO_LINES[i];
    const cut = line.length - 8;
    const main = line.slice(0, cut);
    const three = line.slice(cut);
    const rowColor = chalk.hex(BANNER_GRADIENT[i] ?? "#d97757");
    console.log(` ${rowColor(main)}${chalk.hex("#ffb020").bold(three)}`);
  }
  console.log(`  ${t.dim("Agentic MCP Server Generator")}`);
  console.log();
}

/**
 * Compact command header — replaces the old `displayHeader`. Kept as a thin
 * alias over `sectionHeader` so command files can still call it by that name.
 */
export function displayHeader(title: string, icon?: string): void {
  sectionHeader(title, icon);
}

/**
 * Welcome message box shown after `synapse init` finishes. Draws a real
 * rounded box with a mini section header and available commands.
 */
export function displayWelcome(availableCommands: string[] = []): void {
  const lines: string[] = [];
  lines.push(t.text("You're all set and ready to go."));
  lines.push("");
  lines.push(t.brand("─── Available Commands ───"));
  lines.push("");
  for (const cmd of availableCommands) {
    lines.push(`  ${t.brand("→")} ${t.cmd(cmd)}`);
  }
  console.log();
  roundedBox("🎉  Welcome to Synapse", undefined, t.ok, lines);
  console.log();
}
