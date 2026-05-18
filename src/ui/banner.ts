import chalk from "chalk";
import { t, hrBrand } from "./theme.js";

const W = chalk.white.bold;
const B = chalk.hex("#60a5fa").bold;

// SYNAPS in white, 3 in blue
const LOGO_LINES = [
  ` ${W("███████╗██╗   ██╗███╗   ██╗ █████╗ ██████╗ ███████╗")}${B("██████╗ ")}`,
  ` ${W("██╔════╝╚██╗ ██╔╝████╗  ██║██╔══██╗██╔══██╗██╔════╝")}${B("╚════██╗")}`,
  ` ${W("███████╗ ╚████╔╝ ██╔██╗ ██║███████║██████╔╝███████╗")}${B(" █████╔╝")}`,
  ` ${W("╚════██║  ╚██╔╝  ██║╚██╗██║██╔══██║██╔═══╝ ╚════██║")}${B("╚════██╗ ")}`,
  ` ${W("███████║   ██║   ██║ ╚████║██║  ██║██║     ███████║")}${B("██████╗╝ ")}`,
  ` ${W("╚══════╝   ╚═╝   ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝     ╚══════╝")}${B("╚═════╝ ")}`,
];

export function displayBanner(): void {
  console.log();
  for (const line of LOGO_LINES) {
    console.log(line);
  }
  console.log(`  ${t.dim("Agentic MCP Server Generator")}`);
  console.log();
}

export function displayHeader(title: string): void {
  console.log();
  console.log(`  ${t.brandBold(title)}`);
  console.log(`  ${hrBrand(Math.max(title.length + 4, 40))}`);
}
