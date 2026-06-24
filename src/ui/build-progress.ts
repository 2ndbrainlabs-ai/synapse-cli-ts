/**
 * Build progress UI — shows animated spinner with tool call counter
 * and elapsed time during MCP server generation.
 */

import chalk from "chalk";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class BuildProgressUI {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private toolCalls = 0;
  private startTime = 0;
  private currentStage = "Initializing";
  private lastLineLength = 0;

  start(startTime?: number): void {
    this.startTime = startTime ?? Date.now();
    this.interval = setInterval(() => this.render(), 80);
    this.render();
  }

  updateStage(stage: string): void {
    this.currentStage = stage;
  }

  incrementToolCalls(): void {
    this.toolCalls++;
  }

  complete(): void {
    this.stop();
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
    const line = `  ${chalk.green("✓")}  Generation complete  ${chalk.dim(`${elapsed}s`)}  ${chalk.dim(`${this.toolCalls} tool calls`)}`;
    this.clearLine();
    process.stdout.write(line + "\n\n");
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private render(): void {
    this.frameIdx = (this.frameIdx + 1) % SPINNER_FRAMES.length;
    const spinner = chalk.hex("#d97757")(SPINNER_FRAMES[this.frameIdx]);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
    const toolInfo = this.toolCalls > 0
      ? chalk.hex("#4ade80")(` ${this.toolCalls} tool calls`)
      : "";
    const time = chalk.dim(`${elapsed}s`);
    const stage = chalk.hex("#a5b4fc")(this.currentStage);

    const line = `  ${spinner}  ${stage}  ${time}${toolInfo}`;
    this.clearLine();
    process.stdout.write(line);
    this.lastLineLength = line.replace(/\x1b\[[0-9;]*m/g, "").length;
  }

  private clearLine(): void {
    if (this.lastLineLength > 0) {
      process.stdout.write(`\r${" ".repeat(this.lastLineLength + 2)}\r`);
    } else {
      process.stdout.write("\r");
    }
  }
}
