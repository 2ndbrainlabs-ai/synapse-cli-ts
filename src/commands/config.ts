import {
  getApiKeyDisplay,
  getConfigDisplay,
  isInitialized,
  loadConfig,
  setGlobalApiKey,
  setProjectApiKey,
} from "../config/manager.js";

export interface ConfigOptions {
  update: boolean;
  apiKey?: string;
  globalScope: boolean;
}

export async function runConfig(opts: ConfigOptions): Promise<void> {
  const workingDir = process.cwd();
  const { t, stepOk, sectionBox, sectionHeader, kvLine, hrLine } = await import("../ui/theme.js");

  // Set API key
  if (opts.apiKey) {
    if (opts.globalScope) {
      setGlobalApiKey(opts.apiKey);
      stepOk("Global API key updated");
    } else {
      setProjectApiKey(workingDir, opts.apiKey);
      try { setGlobalApiKey(opts.apiKey); } catch { /* project key was still set */ }
      stepOk("API key updated");
    }
    return;
  }

  // Display config
  if (!isInitialized(workingDir)) {
    sectionBox("Not Initialized", "warn", [
      `Run ${t.cmd("synapse init")} first.`,
      `Use ${t.cmd("synapse config --key <KEY>")} to set a key anyway.`,
    ]);
    return;
  }

  const config = loadConfig(workingDir);
  const entries = getConfigDisplay(config);

  sectionHeader("Configuration");
  console.log();
  for (const [key, value] of entries) {
    kvLine(key, value);
  }

  // Show API key status
  const [projectDisplay, globalDisplay] = getApiKeyDisplay(workingDir);
  console.log();
  kvLine("Project Key", projectDisplay);
  kvLine("Global Key", globalDisplay);
  console.log(`\n  ${hrLine(40)}`);
}
