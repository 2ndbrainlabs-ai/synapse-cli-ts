// src/commands/v2/mode-picker.ts
//
// The initial `synapse build` prompt: Auto vs Custom.
// Skippable via --auto / --custom flags for CI.

import { select } from "@inquirer/prompts";
import { t } from "../../ui/theme.js";

export type BuildMode = "auto" | "custom";

export async function pickBuildMode(opts: {
  autoFlag?: boolean;
  customFlag?: boolean;
}): Promise<BuildMode> {
  if (opts.autoFlag) return "auto";
  if (opts.customFlag) return "custom";

  return await select<BuildMode>({
    message: "How do you want to build your MCP server?",
    choices: [
      {
        name: `${t.brand("Auto")} — expose existing HTTP API as MCP tools`,
        value: "auto",
        description: "Uses synapse-mcp-runner. No code added to your repo.",
      },
      {
        name: `${t.brand("Custom")} — compose internal functions into workflow tools`,
        value: "custom",
        description: "Emits a small MCP server in your language into ./mcp/.",
      },
    ],
  });
}
