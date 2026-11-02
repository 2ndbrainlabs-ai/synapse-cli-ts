// Runs before every test file (vitest.config.ts `setupFiles`). Points HOME
// at a throwaway dir so code that writes to ~/.synapse (e.g. the telemetry
// salt, SYN-367) never touches the developer's or CI runner's real config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
