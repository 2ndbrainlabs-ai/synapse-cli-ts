/**
 * Startup banner + welcome box.
 *
 * SYNAPS3 ASCII logo — white letters with a terracotta-tinted `3` for warmth,
 * routed through the theme's brand color to match the rest of the UI.
 */

import { t, sectionHeader } from "./theme.js";
import { roundedBox } from "./box.js";
import { BOX } from "./icons.js";

// ASCII logo — kept as-is for brand recognition, colors routed through `t`.
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
 */
export function displayBanner(): void {
  console.log();
  // Split each line: main body white/text, last 8-9 chars (the "3") in brand
  for (const line of LOGO_LINES) {
    const cut = line.length - 8;
    const main = line.slice(0, cut);
    const three = line.slice(cut);
    console.log(` ${t.text(main)}${t.brand(three)}`);
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
 * rounded box with the list of available commands.
 */
export function displayWelcome(availableCommands: string[] = []): void {
  const lines: string[] = [];
  lines.push(t.dim("You're all set. Try these commands:"));
  lines.push("");
  for (const cmd of availableCommands) {
    lines.push(`  ${t.brand(BOX.h + "›")} ${t.cmd(cmd)}`);
  }
  console.log();
  roundedBox("🎉  Welcome to Synapse", undefined, t.ok, lines);
  console.log();
}
