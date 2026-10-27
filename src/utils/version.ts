// src/utils/version.ts
//
// The CLI's own version, read once from package.json. Shared by trace records
// (backend/index.ts) and CLI telemetry events (grpc/telemetry.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Returned when package.json can't be found or has no version. */
export const UNKNOWN_CLI_VERSION = "0.0.0";

let _cliVersion: string | null = null;

export function readCliVersion(): string {
  if (_cliVersion) return _cliVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // At runtime this code lives in dist/index.js (bundled) or under
    // src/utils/ / dist/utils/; package.json is one to three directories up.
    for (const candidate of [
      join(here, "..", "package.json"),
      join(here, "..", "..", "package.json"),
      join(here, "..", "..", "..", "package.json"),
    ]) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) {
          _cliVersion = pkg.version;
          return _cliVersion;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  _cliVersion = UNKNOWN_CLI_VERSION;
  return _cliVersion;
}
