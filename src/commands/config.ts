import {
  getApiKeyDisplay,
  getConfigDisplay,
  isInitialized,
  loadConfig,
  setGlobalApiKey,
  setProjectApiKey,
} from "../config/manager.js";
import { t, stepOk, sectionHeader } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";
import { kvGrid, type KvRow } from "../ui/kv-grid.js";
import { EMOJI } from "../ui/icons.js";

export interface ConfigOptions {
  update: boolean;
  apiKey?: string;
  globalScope: boolean;
}

export async function runConfig(opts: ConfigOptions): Promise<void> {
  const workingDir = process.cwd();

  // Set API key path — quick action, no header
  if (opts.apiKey) {
    if (opts.globalScope) {
      setGlobalApiKey(opts.apiKey);
      stepOk("Global API key updated");
    } else {
      setProjectApiKey(workingDir, opts.apiKey);
      try {
        setGlobalApiKey(opts.apiKey);
      } catch {
        /* project key was still set */
      }
      stepOk("API key updated");
    }
    return;
  }

  // Display config
  if (!isInitialized(workingDir)) {
    roundedBox("Not Initialized", "⚠", t.warn, [
      `Run ${t.cmd("synapse init")} first.`,
      "",
      `Use ${t.cmd("synapse config --key <KEY>")} to set a key anyway.`,
    ]);
    return;
  }

  const config = loadConfig(workingDir);
  const entries = getConfigDisplay(config);
  const [projectDisplay, globalDisplay] = getApiKeyDisplay(workingDir);

  sectionHeader("Configuration", EMOJI.config);

  const rows: KvRow[] = entries.map(([key, value]) => ({ key, value }));
  kvGrid(rows);

  console.log();
  console.log(`  ${t.dim("API keys")}`);
  const keyRows: KvRow[] = [
    { key: "Project", value: projectDisplay || t.subtle("(not set)") },
    { key: "Global", value: globalDisplay || t.subtle("(not set)") },
  ];
  kvGrid(keyRows);
  console.log();
}
