import { t } from "./theme.js";

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[91m";
const WHITE = "\x1b[97m";

const SUNSET_BORDER = "\x1b[38;5;94m";
const SUNSET_TITLE = "\x1b[38;5;214m";
const SUNSET_CONTENT = "\x1b[38;5;230m";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[K";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOX_WIDTH_MAX = 100;
const BOX_WIDTH_MIN = 50;
const FRAME_INTERVAL_MS = 40;
const TIP_PAUSE_TICKS = 50; // ~2 seconds at 40ms per tick

const TIPS: readonly string[] = [
  "Build your MCP server once and it works with any AI app. No need to rebuild the same thing over and over for different platforms.",
  "One standard connection for everything. Instead of custom cables for each device, MCP gives AI one universal way to plug into your tools.",
  "Your AI doesn't load every tool upfront. It grabs only what it needs, exactly when needed—saves money and runs faster.",
  "Python, JavaScript, Go, Rust—use whatever language your team already knows. MCP works with all of them.",
  "MCP servers keep your sensitive data behind your firewall. You control who sees what, with built-in security and permissions.",
  "When you add new features, your AI knows immediately. No restarts or manual updates needed—it just works.",
  "What used to take weeks now takes hours. Companies report finishing projects 40-70% faster with MCP servers.",
  "Switch between any AI client without rebuilding. Your server works with all of them—you're never locked in.",
  "Best servers do one thing really well. A weather server does weather. A database server does databases. Simple beats complicated.",
  "Package your server once in Docker, run it anywhere—Mac, Windows, cloud. No more setup headaches.",
  "16,000+ ready-to-use servers for Gmail, Slack, GitHub, Google Drive, and more. Don't rebuild what's already there.",
  "28% of Fortune 500 companies now use MCP servers. In finance, it's 45%. This isn't experimental—it's becoming the standard.",
  "Your AI keeps context across conversations. It remembers your projects, preferences, and history—like talking to someone who actually knows you.",
  "MCP makes AI respond 40-60% faster by cutting out unnecessary steps. Your users notice the speed difference.",
  "Building MCP servers is the fastest way for enterprises to adopt AI and still leverage their existing software assets",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x1f300 || code >= 0x2600) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const word of words) {
    const wordWidth = displayWidth(word);
    if (!currentLine) {
      currentLine = word;
      currentWidth = wordWidth;
    } else if (currentWidth + 1 + wordWidth <= maxWidth) {
      currentLine += " " + word;
      currentWidth += 1 + wordWidth;
    } else {
      lines.push(currentLine);
      currentLine = word;
      currentWidth = wordWidth;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

function getOrbitalFrame(frameIdx: number): string {
  const frames = [
    `${WHITE}╭${RED}╯${RESET}`,
    `${WHITE}╮${RED}╰${RESET}`,
    `${WHITE}╯${RED}╭${RESET}`,
    `${WHITE}╰${RED}╮${RESET}`,
  ];
  return frames[frameIdx % frames.length];
}

// ---------------------------------------------------------------------------
// CodeGenerationUI
// ---------------------------------------------------------------------------

export class CodeGenerationUI {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private currentTipIndex = 0;
  private currentTipCharIndex = 0;
  private tipDisplayComplete = false;
  private tipPauseCounter = 0;
  private totalLines = 0;
  private startTime: number | null = null;
  private orbitalFrame = 0;
  private boxWidth: number;

  constructor() {
    const cols = process.stdout.columns || 80;
    this.boxWidth = Math.min(BOX_WIDTH_MAX, Math.max(BOX_WIDTH_MIN, cols - 2));
  }

  // -------------------------------------------------------------------------
  // Box rendering
  // -------------------------------------------------------------------------

  private renderBox(tipText: string): string[] {
    const lines: string[] = [];
    const innerWidth = this.boxWidth - 2;
    const tipLeftPadding = 3;
    const maxTipWidth = innerWidth - tipLeftPadding * 2;

    // Top border
    lines.push(`${SUNSET_BORDER}╔${"═".repeat(innerWidth)}╗${RESET}`);

    // Empty line
    lines.push(
      `${SUNSET_BORDER}║${RESET}${" ".repeat(innerWidth)}${SUNSET_BORDER}║${RESET}`,
    );

    // Title line
    const titleText = `${BOLD}${SUNSET_TITLE}⚡ PRO TIP${RESET}`;
    const titlePlain = "⚡ PRO TIP";
    const titleWidth = displayWidth(titlePlain);
    const leftPad = Math.floor((innerWidth - titleWidth) / 2);
    const rightPad = innerWidth - leftPad - titleWidth;
    lines.push(
      `${SUNSET_BORDER}║${RESET}${" ".repeat(leftPad)}${titleText}${" ".repeat(rightPad)}${SUNSET_BORDER}║${RESET}`,
    );

    // Empty line after title
    lines.push(
      `${SUNSET_BORDER}║${RESET}${" ".repeat(innerWidth)}${SUNSET_BORDER}║${RESET}`,
    );

    // Tip text lines (max 2 wrapped lines)
    const wrappedLines = wrapText(tipText, maxTipWidth);
    while (wrappedLines.length < 2) {
      wrappedLines.push("");
    }

    for (const wrappedLine of wrappedLines.slice(0, 2)) {
      const tipDisplayWidth = displayWidth(wrappedLine);
      const tipRightPadding = Math.max(
        0,
        innerWidth - tipLeftPadding - tipDisplayWidth,
      );
      lines.push(
        `${SUNSET_BORDER}║${RESET}${" ".repeat(tipLeftPadding)}${SUNSET_CONTENT}${wrappedLine}${RESET}${" ".repeat(tipRightPadding)}${SUNSET_BORDER}║${RESET}`,
      );
    }

    // Empty line before bottom
    lines.push(
      `${SUNSET_BORDER}║${RESET}${" ".repeat(innerWidth)}${SUNSET_BORDER}║${RESET}`,
    );

    // Bottom border
    lines.push(`${SUNSET_BORDER}╚${"═".repeat(innerWidth)}╝${RESET}`);

    return lines;
  }

  // -------------------------------------------------------------------------
  // Animation tick
  // -------------------------------------------------------------------------

  private tick(): void {
    const tipIdx = this.currentTipIndex;
    const charIdx = this.currentTipCharIndex;
    const currentTip = TIPS[tipIdx % TIPS.length];
    const visibleTip = currentTip.slice(0, charIdx);

    const orbital = getOrbitalFrame(this.orbitalFrame);

    let elapsedStr = "";
    if (this.startTime !== null) {
      elapsedStr = "  " + formatElapsed((Date.now() - this.startTime) / 1000);
    }

    const statusLine = `  ${orbital} Generating MCP server${elapsedStr}`;
    const boxLines = this.renderBox(visibleTip);

    // Move cursor up to overwrite previous output
    if (this.totalLines > 0) {
      process.stdout.write(`\x1b[${this.totalLines}A`);
    }

    // Write status line
    process.stdout.write(`\r${CLEAR_LINE}${statusLine}\n`);

    // Write box lines
    for (const line of boxLines) {
      process.stdout.write(`\r${CLEAR_LINE}${line}\n`);
    }

    this.totalLines = 1 + boxLines.length;
    this.orbitalFrame++;

    // Typewriter logic
    if (!this.tipDisplayComplete) {
      if (this.currentTipCharIndex < currentTip.length) {
        this.currentTipCharIndex++;
      } else {
        this.tipDisplayComplete = true;
        this.tipPauseCounter = 0;
      }
    } else {
      this.tipPauseCounter++;
      if (this.tipPauseCounter > TIP_PAUSE_TICKS) {
        this.currentTipIndex = (this.currentTipIndex + 1) % TIPS.length;
        this.currentTipCharIndex = 0;
        this.tipDisplayComplete = false;
        this.tipPauseCounter = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(startTime?: number): void {
    process.stdout.write(HIDE_CURSOR);

    this.currentTipIndex = 0;
    this.currentTipCharIndex = 0;
    this.tipDisplayComplete = false;
    this.tipPauseCounter = 0;
    this.totalLines = 0;
    this.orbitalFrame = 0;
    this.startTime = startTime ?? Date.now();

    // Initial blank lines so the first tick can overwrite them
    process.stdout.write("\n"); // status line placeholder
    const boxLines = this.renderBox("");
    for (const _ of boxLines) {
      process.stdout.write("\n");
    }
    this.totalLines = 1 + boxLines.length;

    this.intervalId = setInterval(() => this.tick(), FRAME_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    process.stdout.write(SHOW_CURSOR);
  }

  complete(): void {
    this.stop();

    // Clear the animation area
    if (this.totalLines > 0) {
      process.stdout.write(`\x1b[${this.totalLines}A`);
      for (let i = 0; i < this.totalLines; i++) {
        process.stdout.write(`\r${CLEAR_LINE}\n`);
      }
      process.stdout.write(`\x1b[${this.totalLines}A`);
    }

    // Print completion message using theme
    let elapsedStr = "";
    if (this.startTime !== null) {
      elapsedStr = "  " + formatElapsed((Date.now() - this.startTime) / 1000);
    }
    console.log(`  ${t.ok("✓")}  Generation complete${elapsedStr}`);
  }
}
