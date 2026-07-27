// src/commands/v2/mode-picker.ts
//
// Ember mode picker — the visual centerpiece of the redesign.
//
// At medium+ width we render two cards side-by-side; ← → moves between
// them, Enter confirms. At narrow width we fall back to a normal single-
// column select so nothing overflows.
//
// Skippable via --auto / --custom flags. Also skipped when
// SYNAPSE_NON_INTERACTIVE is set (returns 'auto' by default).

import { t } from "../../ui/theme.js";
import { askSelect } from "../../ui/prompt.js";
import { breakpoint, twoColumnWidth } from "../../ui/layout.js";
import { BOX, DOT_FILLED, CIRCLE, ARROW_R } from "../../ui/icons.js";
import { displayWidth } from "../../ui/theme.js";

export type BuildMode = "auto" | "custom";

interface Card {
  value: BuildMode;
  title: string;
  tagline: string;
  bullets: string[];
}

const CARDS: Card[] = [
  {
    value: "auto",
    title: "Auto",
    tagline: "Detect API routes automatically",
    bullets: ["Fastest path", "Best for REST APIs", "Zero code prompts"],
  },
  {
    value: "custom",
    title: "Custom",
    tagline: "Compose tools from any functions",
    bullets: ["Full control", "Any language", "Guided prompts"],
  },
];

export async function pickBuildMode(opts: {
  autoFlag?: boolean;
  customFlag?: boolean;
}): Promise<BuildMode> {
  if (opts.autoFlag) return "auto";
  if (opts.customFlag) return "custom";

  // Non-interactive / narrow terminals get the fallback single-column select.
  const bp = breakpoint();
  if (process.env.SYNAPSE_NON_INTERACTIVE === "1" || bp === "narrow") {
    return await fallbackSelect();
  }

  return await interactiveCardPicker();
}

// ---------------------------------------------------------------------------
// Fallback: standard @inquirer select. Used on narrow terminals + CI.
// ---------------------------------------------------------------------------

async function fallbackSelect(): Promise<BuildMode> {
  return await askSelect<BuildMode>({
    message: "How do you want to build your MCP server?",
    choices: CARDS.map((c) => ({
      name: `${t.brand(c.title)} — ${c.tagline}`,
      value: c.value,
      description: c.bullets.join(" · "),
    })),
    defaultValue: "auto",
  });
}

// ---------------------------------------------------------------------------
// Interactive dual-card picker. Uses raw-mode readline for ← → navigation.
// ---------------------------------------------------------------------------

async function interactiveCardPicker(): Promise<BuildMode> {
  return new Promise<BuildMode>((resolve, reject) => {
    let cursor = 0; // index into CARDS
    const stdin = process.stdin;
    const rawWasEnabled = stdin.isRaw;

    // Reserve the vertical space we're about to redraw across.
    const cardHeight = 8; // top + title + blank + 3 bullets + bottom + hint = ~8 lines
    const header = "How do you want to build?";

    process.stdout.write("\n");
    process.stdout.write(`  ${t.bold(t.primary(header))}\n\n`);
    // Reserve N lines that we'll overwrite in redraw().
    for (let i = 0; i < cardHeight; i++) process.stdout.write("\n");

    const cleanup = () => {
      try { stdin.setRawMode(rawWasEnabled); } catch { /* ignore */ }
      stdin.pause();
      stdin.removeListener("data", onKey);
    };

    const onKey = (buf: Buffer) => {
      const seq = buf.toString("utf-8");

      // Ctrl-C exits cleanly (the global handler in index.ts prints the friendly line)
      if (seq === "") {
        cleanup();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const err = new Error("User force closed the prompt with SIGINT") as any;
        err.name = "ExitPromptError";
        reject(err);
        return;
      }
      // Enter / return
      if (seq === "\r" || seq === "\n") {
        cleanup();
        // Move past the reserved area cleanly.
        process.stdout.write("\n");
        resolve(CARDS[cursor].value);
        return;
      }
      // ← / → and h / l (vim-style, why not)
      if (seq === "[D" || seq === "h") { cursor = (cursor + CARDS.length - 1) % CARDS.length; redraw(); return; }
      if (seq === "[C" || seq === "l") { cursor = (cursor + 1) % CARDS.length; redraw(); return; }
      // Tab
      if (seq === "\t") { cursor = (cursor + 1) % CARDS.length; redraw(); return; }
      // Number shortcuts (1, 2)
      if (seq === "1" && CARDS[0]) { cursor = 0; redraw(); return; }
      if (seq === "2" && CARDS[1]) { cursor = 1; redraw(); return; }
    };

    const redraw = () => {
      // Move cursor up to the top of the reserved area.
      process.stdout.write(`\x1b[${cardHeight}A`);
      const lines = renderCards(cursor);
      for (let i = 0; i < cardHeight; i++) {
        // Clear line before writing so shorter lines don't leave debris.
        process.stdout.write(`\x1b[2K${lines[i] ?? ""}\n`);
      }
    };

    try { stdin.setRawMode(true); } catch { /* ignore */ }
    stdin.resume();
    stdin.on("data", onKey);
    redraw();
  });
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

function renderCards(activeIdx: number): string[] {
  const cardWidth = Math.max(24, twoColumnWidth());
  const rows: string[][] = CARDS.map((c, i) => renderOneCard(c, i === activeIdx, cardWidth));

  const height = Math.max(rows[0].length, rows[1].length);
  const combined: string[] = [];
  for (let i = 0; i < height; i++) {
    combined.push(`  ${rows[0][i] ?? " ".repeat(cardWidth + 2)}   ${rows[1][i] ?? ""}`);
  }
  // Trailing keybinding hint
  combined.push("");
  combined.push(
    `  ${t.subtle(`← →  choose    ${ARROW_R}  ⏎ continue`)}`,
  );
  // Pad to fixed height so redraw() has predictable line count.
  while (combined.length < 8) combined.push("");
  return combined;
}

function renderOneCard(card: Card, active: boolean, width: number): string[] {
  const border = active ? t.brand : t.faint;
  const dot = active ? t.brand(DOT_FILLED) : t.faint(CIRCLE);
  const title = active ? t.brandBold(card.title) : t.warm(card.title);

  const inner = width - 2;
  const pad = (s: string) => {
    const w = displayWidth(s);
    return s + " ".repeat(Math.max(0, inner - w));
  };

  const rows: string[] = [];
  rows.push(border(BOX.tl + BOX.h.repeat(width) + BOX.tr));
  rows.push(border(BOX.v) + " " + pad(`${dot}  ${title}`) + " " + border(BOX.v));
  rows.push(border(BOX.v) + " " + pad(t.subtle(card.tagline)) + " " + border(BOX.v));
  rows.push(border(BOX.v) + " " + pad("") + " " + border(BOX.v));
  for (const b of card.bullets) {
    rows.push(border(BOX.v) + " " + pad(`${t.subtle("•")} ${t.warm(b)}`) + " " + border(BOX.v));
  }
  rows.push(border(BOX.bl + BOX.h.repeat(width) + BOX.br));
  return rows;
}
