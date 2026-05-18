const RED = "\x1b[91m";
const WHITE = "\x1b[97m";
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";

type Style = "ellipsis" | "orbital";

function formatElapsed(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
  }
  return `${Math.floor(seconds)}s`;
}

export class ProgressIndicator {
  private interval: ReturnType<typeof setInterval> | null = null;
  private currentMessage = "";
  private currentStyle: Style = "ellipsis";
  private startTime: number | null = null;
  private showTimer = false;
  private frameIdx = 0;

  private static readonly ORBITAL_FRAMES = [
    `${WHITE}╭${RED}╯${RESET}`,
    `${WHITE}╮${RED}╰${RESET}`,
    `${WHITE}╯${RED}╭${RESET}`,
    `${WHITE}╰${RED}╮${RESET}`,
  ];

  private static readonly ELLIPSIS_FRAMES = ["", ".", "..", "..."];

  private render(): void {
    let timerStr = "";
    if (this.showTimer && this.startTime !== null) {
      timerStr = "  " + formatElapsed((Date.now() - this.startTime) / 1000);
    }

    if (this.currentStyle === "orbital") {
      const frame =
        ProgressIndicator.ORBITAL_FRAMES[
          this.frameIdx % ProgressIndicator.ORBITAL_FRAMES.length
        ];
      process.stdout.write(
        `\r  ${frame} ${this.currentMessage}${timerStr}   `,
      );
    } else {
      const frame =
        ProgressIndicator.ELLIPSIS_FRAMES[
          this.frameIdx % ProgressIndicator.ELLIPSIS_FRAMES.length
        ];
      process.stdout.write(
        `\r  ⏳ ${this.currentMessage}${frame}${timerStr}   `,
      );
    }

    this.frameIdx++;
  }

  start(
    message: string,
    style: Style = "ellipsis",
    showTimer = false,
  ): void {
    this.stop();
    this.currentMessage = message;
    this.currentStyle = style;
    this.frameIdx = 0;

    if (showTimer) {
      this.showTimer = true;
      if (this.startTime === null) {
        this.startTime = Date.now();
      }
    }

    const sleepTime = style === "orbital" ? 120 : 400;
    this.render();
    this.interval = setInterval(() => this.render(), sleepTime);
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write("\r" + " ".repeat(80) + "\r");
    }
  }

  complete(message: string): void {
    let timerStr = "";
    if (this.showTimer && this.startTime !== null) {
      timerStr = "  " + formatElapsed((Date.now() - this.startTime) / 1000);
    }
    this.stop();
    console.log(`  ${GREEN}✓${RESET}  ${message}${timerStr}`);
  }

  fail(message: string): void {
    this.stop();
    console.log(`  ${RED}✖${RESET} ${message}`);
  }

  update(message: string): void {
    this.currentMessage = message;
  }

  resetTimer(): void {
    this.startTime = null;
    this.showTimer = false;
  }
}
