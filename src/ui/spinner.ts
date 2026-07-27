/**
 * Unified spinner — Ember mode: single Braille-dots animation @ 80ms.
 *
 * The old three-mode API (`ellipsis` / `orbital` / `braille`) is preserved
 * as a type + constructor arg for back-compat, but every mode now maps to
 * Braille. The orbital `╭╯╮╰` glyph is retired from spinner duty and gets
 * a second life as the `✦ Ready` completion mark in success screens.
 *
 * Non-TTY / NO_COLOR / CI behavior — the biggest bug fix here:
 *
 *   Before: `clearLine()` wrote `\n` every 80ms in non-TTY mode → CI logs
 *   spammed with blank lines. `render()` also fired for every timer tick.
 *   After:  non-TTY emits ONE line on `start(message)`, ONE more line only
 *   when `updateMessage()` changes text, and a final completion line on
 *   `complete()` / `fail()`. Zero output between message changes.
 *
 * Public API is unchanged: `start`, `updateMessage`, `updateMeta`,
 * `complete`, `fail`, `stop`, `resetTimer`.
 */

import { t, fmtDuration, displayWidth } from "./theme.js";
import { OK, ERR, BRAILLE_FRAMES } from "./icons.js";
import { SPINNER_FRAME_MS } from "./motion.js";

export type SpinnerMode = "ellipsis" | "orbital" | "braille";

interface StartOpts {
  /** Reset the cumulative timer. Default false — keep counting across stages. */
  resetTimer?: boolean;
}

interface Meta {
  /** Extra dim info shown after the message (e.g. "128 files · 12 matched"). */
  extra?: string;
}

export class Spinner {
  // Retained as a constructor arg so `new Spinner("orbital")` still works;
  // every mode collapses to Braille internally. Kept as `_mode` to appease
  // TypeScript "declared but not read" — deleting the field would need a
  // constructor signature change.
  private message = "";
  private cumulativeStart = 0;
  private frameIdx = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private meta: Meta = {};
  private lastLineLen = 0;
  private lastPrintedMessage = ""; // non-TTY only — dedup message spam
  private staticTicker: ReturnType<typeof setInterval> | null = null;

  constructor(_mode: SpinnerMode = "braille") {
    // `_mode` retained as a positional arg so `new Spinner("orbital")` still
    // parses; every mode collapses to Braille internally in Ember.
    void _mode;
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
    this.frameIdx = 0;

    if (t.env.noAnimation) {
      // Non-TTY: emit once on start, and again only when message changes.
      this.renderStatic();
      // Static ticker refreshes elapsed time every 10s so long-running
      // stages still show progress, without spamming per second.
      this.staticTicker = setInterval(() => this.renderStatic(), 10_000);
      return;
    }

    this.render();
    this.ticker = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % BRAILLE_FRAMES.length;
      this.render();
    }, SPINNER_FRAME_MS);
  }

  /** Update the message shown next to the spinner. */
  updateMessage(message: string): void {
    this.message = message;
    // In non-TTY mode, print immediately so the log reflects the transition.
    if (t.env.noAnimation) this.renderStatic();
  }

  /** Update the trailing meta info. */
  updateMeta(meta: Meta): void {
    this.meta = { ...this.meta, ...meta };
  }

  /** Complete successfully. Prints `  ✓  message  1m 3s`. */
  complete(message?: string, timing?: string): void {
    this.stopTickers();
    this.clearLine();
    const msg = message ?? this.message;
    const elapsed = timing ?? fmtDuration(Date.now() - this.cumulativeStart);
    console.log(`  ${t.ok(OK)}  ${t.warm(msg)}  ${t.subtle(elapsed)}`);
  }

  /** Fail. Prints `  ✗  message  detail`. */
  fail(message?: string, detail = ""): void {
    this.stopTickers();
    this.clearLine();
    const msg = message ?? this.message;
    const d = detail ? `  ${t.subtle(detail)}` : "";
    console.log(`  ${t.err(ERR)}  ${t.warm(msg)}${d}`);
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
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.staticTicker) { clearInterval(this.staticTicker); this.staticTicker = null; }
  }

  /** Ember: always Braille dots, brand-colored. */
  private frame(): string {
    return t.brand(BRAILLE_FRAMES[this.frameIdx]);
  }

  private render(): void {
    const elapsed = fmtDuration(Date.now() - this.cumulativeStart);
    const extra = this.meta.extra ? `  ${t.subtle("·")}  ${t.subtle(this.meta.extra)}` : "";
    const line = `  ${this.frame()}  ${t.warm(this.message)}  ${t.subtle(elapsed)}${extra}`;
    this.clearLine();
    process.stdout.write(line);
    this.lastLineLen = displayWidth(line);
  }

  private renderStatic(): void {
    // Non-TTY mode: emit a full line ONLY when the message changes.
    // Elapsed / meta refreshes hitchhike on the next message transition
    // (this is what CI logs actually want — one line per phase, not per tick).
    if (this.message === this.lastPrintedMessage) return;
    this.lastPrintedMessage = this.message;

    const elapsed = fmtDuration(Date.now() - this.cumulativeStart);
    const extra = this.meta.extra ? `  ${this.meta.extra}` : "";
    // Ember non-TTY prefix: `[working]` matches the plan; label stays plain.
    console.log(`  [working]  ${this.message}  ${elapsed}${extra}`);
  }

  private clearLine(): void {
    if (!t.env.isTTY) {
      // Fix (Ember): do NOT emit `\n` here. In non-TTY mode we don't clear
      // anything — non-TTY renders happen once per message change, not per
      // tick, so there's nothing to erase.
      return;
    }
    if (this.lastLineLen > 0) {
      process.stdout.write(`\r${" ".repeat(this.lastLineLen + 2)}\r`);
    } else {
      process.stdout.write("\r");
    }
    this.lastLineLen = 0;
  }
}
