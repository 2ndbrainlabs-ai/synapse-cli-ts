/**
 * Unified spinner — three modes: ellipsis, orbital (Synapse signature), braille.
 *
 * Replaces the previous three separate implementations. Supports:
 *   - cumulative timer across sequential start() calls
 *   - meta line updates (extra info like "N tool calls")
 *   - reduced-motion / non-TTY fallback (renders as `[working] 12s`)
 *   - complete() and fail() print a final line with the elapsed time
 */

import { t, fmtDuration } from "./theme.js";
import { OK, ERR, ORBITAL_FRAMES, BRAILLE_FRAMES } from "./icons.js";

export type SpinnerMode = "ellipsis" | "orbital" | "braille";

interface StartOpts {
  /** Reset the cumulative timer. Default true — pass false to keep counting. */
  resetTimer?: boolean;
}

interface Meta {
  /** Extra dim info shown after the message (e.g. "4 tool calls"). */
  extra?: string;
}

export class Spinner {
  private mode: SpinnerMode;
  private message = "";
  private startTime = 0;
  private cumulativeStart = 0;
  private frameIdx = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private meta: Meta = {};
  private lastLineLen = 0;
  private staticTicker: ReturnType<typeof setInterval> | null = null;

  constructor(mode: SpinnerMode = "orbital") {
    this.mode = mode;
    this.cumulativeStart = Date.now();
  }

  /** Reset the cumulative timer to zero. Call before a fresh sequence. */
  resetTimer(): void {
    this.cumulativeStart = Date.now();
  }

  /** Start a new stage. */
  start(message: string, opts: StartOpts = {}): void {
    if (opts.resetTimer) this.cumulativeStart = Date.now();
    this.message = message;
    this.meta = {};
    this.startTime = Date.now();
    this.frameIdx = 0;

    if (t.env.noAnimation) {
      this.renderStatic();
      // Refresh timer every second so elapsed keeps ticking
      this.staticTicker = setInterval(() => this.renderStatic(), 1000);
      return;
    }

    this.render();
    const interval =
      this.mode === "braille" ? 80 : this.mode === "orbital" ? 120 : 400;
    this.ticker = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % this.frameCount();
      this.render();
    }, interval);
  }

  /** Update the message shown next to the spinner. */
  updateMessage(message: string): void {
    this.message = message;
  }

  /** Update the trailing meta info (e.g. tool-call counter). */
  updateMeta(meta: Meta): void {
    this.meta = { ...this.meta, ...meta };
  }

  /** Complete successfully. Prints `  ✓  message  1m 3s`. */
  complete(message?: string, timing?: string): void {
    this.stopTickers();
    this.clearLine();
    const msg = message ?? this.message;
    const elapsed = timing ?? fmtDuration(Date.now() - this.cumulativeStart);
    console.log(`  ${t.ok(OK)}  ${t.text(msg)}  ${t.dim(elapsed)}`);
  }

  /** Fail. Prints `  ✖  message  detail`. */
  fail(message?: string, detail = ""): void {
    this.stopTickers();
    this.clearLine();
    const msg = message ?? this.message;
    const d = detail ? `  ${t.dim(detail)}` : "";
    console.log(`  ${t.err(ERR)}  ${t.text(msg)}${d}`);
  }

  /** Stop the spinner and clear its line without printing a completion. */
  stop(): void {
    this.stopTickers();
    this.clearLine();
  }

  // -----------------------------------------------------------------------
  // Internal rendering
  // -----------------------------------------------------------------------

  private stopTickers(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.staticTicker) {
      clearInterval(this.staticTicker);
      this.staticTicker = null;
    }
  }

  private frameCount(): number {
    if (this.mode === "braille") return BRAILLE_FRAMES.length;
    if (this.mode === "orbital") return ORBITAL_FRAMES.length;
    return 4; // ellipsis: 0-3 dots
  }

  private frame(): string {
    if (this.mode === "braille") {
      return t.brand(BRAILLE_FRAMES[this.frameIdx]);
    }
    if (this.mode === "orbital") {
      return renderOrbital(ORBITAL_FRAMES[this.frameIdx]);
    }
    // ellipsis
    const dots = ".".repeat(this.frameIdx);
    return `⏳${dots}`;
  }

  private render(): void {
    const elapsed = fmtDuration(Date.now() - this.cumulativeStart);
    const extra = this.meta.extra ? `  ${t.dim(this.meta.extra)}` : "";
    const line = `  ${this.frame()}  ${t.text(this.message)}  ${t.dim(elapsed)}${extra}`;
    this.clearLine();
    process.stdout.write(line);
    this.lastLineLen = displayWidthApprox(line);
  }

  private renderStatic(): void {
    const elapsed = fmtDuration(Date.now() - this.cumulativeStart);
    const extra = this.meta.extra ? `  ${t.dim(this.meta.extra)}` : "";
    const line = `  ${t.dim("[working]")}  ${t.text(this.message)}  ${t.dim(elapsed)}${extra}`;
    this.clearLine();
    process.stdout.write(line);
    this.lastLineLen = displayWidthApprox(line);
  }

  private clearLine(): void {
    if (!t.env.isTTY) {
      process.stdout.write("\n");
      this.lastLineLen = 0;
      return;
    }
    if (this.lastLineLen > 0) {
      process.stdout.write(`\r${" ".repeat(this.lastLineLen + 2)}\r`);
    } else {
      process.stdout.write("\r");
    }
  }
}

/**
 * The orbital spinner uses a 2-char glyph pair — one white, one terracotta —
 * which creates the "atom rotating" visual signature of Synapse.
 */
function renderOrbital(frame: string): string {
  const [a, b] = [frame.charAt(0), frame.charAt(1)];
  return t.text(a) + t.brand(b);
}

/**
 * Approximate display width — good enough for line-clear. Emoji count as 2.
 */
function displayWidthApprox(s: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x1f000 || (code >= 0x2600 && code <= 0x27bf)) w += 2;
    else w += 1;
  }
  return w;
}
