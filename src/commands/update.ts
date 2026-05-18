import { execSync } from "node:child_process";

export async function runUpdate(): Promise<void> {
  const { t, sectionBox } = await import("../ui/theme.js");

  console.log(`\n  ${t.brand("Updating Synapse CLI...")}\n`);

  try {
    const output = execSync("npm update -g @synapse/cli", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (output.trim()) {
      console.log(`  ${t.dim(output.trim())}`);
    }

    sectionBox("Update Complete", "ok", [
      "Synapse CLI has been updated to the latest version.",
      `Run ${t.cmd("synapse --version")} to verify.`,
    ]);
  } catch (e: any) {
    const stderr = e.stderr?.toString() ?? "";
    sectionBox("Update Failed", "err", [
      "Could not update Synapse CLI.",
      stderr ? `Error: ${stderr.trim()}` : "Try running manually:",
      `  ${t.cmd("npm update -g @synapse/cli")}`,
    ]);
    process.exitCode = 1;
  }
}
