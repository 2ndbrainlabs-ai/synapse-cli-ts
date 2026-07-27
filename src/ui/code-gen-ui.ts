/**
 * CodeGenerationUI — the "⚡ Pro Tip" animated box shown during generation.
 *
 * Two visual layers:
 *   1. Orbital spinner status line: `  ╭╯  Generating MCP server   1m 3s`
 *   2. Rounded box with rotating typewriter tips + shimmer accent on the title
 *
 * Reduced-motion / non-TTY: renders as a plain static tip line, no animation.
 * Uses only theme colors — no raw 256-color ANSI outside the theme.
 */

import { t, fmtDuration, stripAnsi, displayWidth } from "./theme.js";
import { ORBITAL_FRAMES, BOX, SPARK } from "./icons.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[K";

const FRAME_INTERVAL_MS = 50; // 20fps — intentional, not frantic
const TIP_TYPEWRITER_MS = 30;
const TIP_PAUSE_MS = 4000;
const BOX_WIDTH_MIN = 50;
const BOX_WIDTH_MAX = 80;

// Synapse-specific tips — different from Python's generic MCP marketing copy.
// Focused on what a Synapse user actually needs to know.
const TIPS: readonly string[] = [
  "Every function you expose becomes a tool your AI can call. Keep them small and focused for best results.",
  "Give your functions clear docstrings — the AI reads them to decide when to invoke each tool.",
  "Typed parameters (str, int, dict) help the AI generate correct arguments. Avoid `Any` when you can.",
  "Return dicts or Pydantic models instead of complex objects — MCP needs JSON-serializable output.",
  "Secrets and API keys should live in environment variables, not function defaults. Synapse handles this for you.",
  "Group related functions into a single MCP server. Small, cohesive servers work better than sprawling ones.",
  "Add validation at the start of each tool — reject bad inputs with clear error messages the AI can learn from.",
  "The best tools do one thing well. If a function does two things, consider splitting it.",
  "Async functions handle I/O concurrently. Use them for network calls, database queries, and file operations.",
  "Test your MCP server locally with `python mcp_server.py` before adding it to your AI client.",
];

export class CodeGenerationUI {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private tipIndex = 0;
  private tipCharIndex = 0;
  private tipComplete = false;
  private tipPauseUntil = 0;
  private lastCharAdvance = 0;
  private startTime = 0;
  private orbitalFrame = 0;
  private totalRenderedLines = 0;
  private boxWidth: number;

  constructor() {
    const cols = process.stdout.columns || 80;
    this.boxWidth = Math.min(BOX_WIDTH_MAX, Math.max(BOX_WIDTH_MIN, cols - 6));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(startTime?: number): void {
    this.startTime = startTime ?? Date.now();
    this.tipIndex = Math.floor(Math.random() * TIPS.length);
    this.tipCharIndex = 0;
    this.tipComplete = false;
    this.lastCharAdvance = Date.now();

    if (t.env.noAnimation) {
      // Static rendering — one shot, no animation
      this.renderStatic();
      return;
    }

    process.stdout.write(HIDE_CURSOR);

    // Reserve vertical space by printing blank lines equal to what tick renders
    const initialLines = this.renderFrame(TIPS[this.tipIndex]);
    for (const line of initialLines) process.stdout.write(line + "\n");
    this.totalRenderedLines = initialLines.length;

    this.intervalId = setInterval(() => this.tick(), FRAME_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (!t.env.noAnimation) process.stdout.write(SHOW_CURSOR);
  }

  complete(): void {
    this.stop();
    // Clear the animation area
    if (!t.env.noAnimation && this.totalRenderedLines > 0) {
      process.stdout.write(`\x1b[${this.totalRenderedLines}A`);
      for (let i = 0; i < this.totalRenderedLines; i++) {
        process.stdout.write(`\r${CLEAR_LINE}\n`);
      }
      process.stdout.write(`\x1b[${this.totalRenderedLines}A`);
    }
    const elapsed = fmtDuration(Date.now() - this.startTime);
    console.log(`  ${t.ok("✓")}  ${t.text("Generation complete")}  ${t.dim(elapsed)}`);
  }

  // -------------------------------------------------------------------------
  // Animation frame
  // -------------------------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    const currentTip = TIPS[this.tipIndex % TIPS.length];

    // Advance the typewriter
    if (!this.tipComplete) {
      if (now - this.lastCharAdvance >= TIP_TYPEWRITER_MS) {
        this.tipCharIndex = Math.min(this.tipCharIndex + 1, currentTip.length);
        this.lastCharAdvance = now;
        if (this.tipCharIndex >= currentTip.length) {
          this.tipComplete = true;
          this.tipPauseUntil = now + TIP_PAUSE_MS;
        }
      }
    } else if (now >= this.tipPauseUntil) {
      this.tipIndex = (this.tipIndex + 1) % TIPS.length;
      this.tipCharIndex = 0;
      this.tipComplete = false;
      this.lastCharAdvance = now;
    }

    this.orbitalFrame = (this.orbitalFrame + 1) % ORBITAL_FRAMES.length;

    const visibleTip = currentTip.slice(0, this.tipCharIndex);
    const lines = this.renderFrame(visibleTip);

    // Repaint in place
    if (this.totalRenderedLines > 0) {
      process.stdout.write(`\x1b[${this.totalRenderedLines}A`);
    }
    for (const line of lines) {
      process.stdout.write(`\r${CLEAR_LINE}${line}\n`);
    }
    this.totalRenderedLines = lines.length;
  }

  // -------------------------------------------------------------------------
  // Frame composition
  // -------------------------------------------------------------------------

  private renderFrame(tipVisibleText: string): string[] {
    const lines: string[] = [];

    // Status line
    const frame = ORBITAL_FRAMES[this.orbitalFrame % ORBITAL_FRAMES.length];
    const orbital = t.text(frame.charAt(0)) + t.brand(frame.charAt(1));
    const elapsed = fmtDuration(Date.now() - this.startTime);
    lines.push(
      `  ${orbital}  ${t.text("Generating MCP server")}  ${t.dim(elapsed)}`,
    );
    lines.push(""); // blank spacer

    // Box
    const innerWidth = this.boxWidth;
    const innerPad = 2;
    const contentWidth = innerWidth - innerPad * 2;

    // Top border
    lines.push(
      `  ${t.accent(BOX.tl + BOX.h.repeat(innerWidth) + BOX.tr)}`,
    );

    // Title row (⚡  Pro Tip) — accent shimmer color for warmth
    const titleText = `${SPARK}  ${t.accentBold("Pro Tip")}`;
    const titleWidth = displayWidth(stripAnsi(titleText));
    const titleRightPad = Math.max(0, innerWidth - innerPad - titleWidth);
    lines.push(
      `  ${t.accent(BOX.v)}${" ".repeat(innerPad)}${t.accentShim(SPARK)}  ${t.accentBold("Pro Tip")}${" ".repeat(titleRightPad)}${t.accent(BOX.v)}`,
    );

    // Blank line
    lines.push(
      `  ${t.accent(BOX.v)}${" ".repeat(innerWidth)}${t.accent(BOX.v)}`,
    );

    // Tip content — wrap to fit
    const wrapped = wrapText(tipVisibleText, contentWidth);
    // Ensure exactly 3 body lines for a stable footprint
    while (wrapped.length < 3) wrapped.push("");
    for (const wrappedLine of wrapped.slice(0, 3)) {
      const w = displayWidth(wrappedLine);
      const rightPad = Math.max(0, innerWidth - innerPad - w);
      lines.push(
        `  ${t.accent(BOX.v)}${" ".repeat(innerPad)}${t.warm(wrappedLine)}${" ".repeat(rightPad)}${t.accent(BOX.v)}`,
      );
    }

    // Blank line
    lines.push(
      `  ${t.accent(BOX.v)}${" ".repeat(innerWidth)}${t.accent(BOX.v)}`,
    );

    // Bottom border
    lines.push(
      `  ${t.accent(BOX.bl + BOX.h.repeat(innerWidth) + BOX.br)}`,
    );

    return lines;
  }

  private renderStatic(): void {
    // Single-shot render for non-animated environments
    const currentTip = TIPS[this.tipIndex];
    console.log(`  ${t.text("Generating MCP server…")}`);
    console.log();
    console.log(`  ${t.accentShim(SPARK)}  ${t.accentBold("Pro Tip:")} ${t.warm(currentTip)}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
