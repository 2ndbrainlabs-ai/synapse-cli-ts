import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

export async function runUninstall(): Promise<void> {
  const { t, sectionBox } = await import("../ui/theme.js");
  const { confirm } = await import("@inquirer/prompts");

  console.log();
  sectionBox("Uninstall Synapse", "warn", [
    "This will remove:",
    `  • Global config: ${t.path("~/.synapse")}`,
    `  • The ${t.cmd("synapse")} CLI binary`,
    "",
    "Project-level .synapse/ directories will NOT be removed.",
  ]);

  const proceed = await confirm({
    message: "Are you sure you want to uninstall Synapse?",
    default: false,
  });

  if (!proceed) {
    console.log(`\n  ${t.dim("Uninstall cancelled.")}\n`);
    return;
  }

  const globalDir = path.join(os.homedir(), ".synapse");

  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    console.log(`  ${t.ok("✓")} Removed ${t.path("~/.synapse")}`);
  }

  console.log(`\n  ${t.dim("Removing npm package...")}`);

  try {
    execSync("npm uninstall -g @2ndbrainlabs-ai/synapse-cli", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`  ${t.ok("✓")} Removed @2ndbrainlabs-ai/synapse-cli\n`);
  } catch {
    console.log(`\n  ${t.dim("To complete removal, run:")}`);
    console.log(`  ${t.cmd("npm uninstall -g @2ndbrainlabs-ai/synapse-cli")}\n`);
  }

  console.log(`  ${t.dim("Synapse has been uninstalled. Goodbye!")}\n`);
}
