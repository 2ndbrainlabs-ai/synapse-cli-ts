import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILE = path.join(os.homedir(), ".synapse", ".version-check.json");

interface VersionCache {
  latestVersion: string;
  checkedAt: number;
}

export async function checkForUpdate(currentVersion: string): Promise<void> {
  try {
    const cached = readCache();
    if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
      if (isNewer(cached.latestVersion, currentVersion)) {
        printUpdateNotice(currentVersion, cached.latestVersion);
      }
      return;
    }

    const latest = await fetchLatestVersion();
    if (!latest) return;

    writeCache({ latestVersion: latest, checkedAt: Date.now() });

    if (isNewer(latest, currentVersion)) {
      printUpdateNotice(currentVersion, latest);
    }
  } catch {
    // Never block CLI on version check failure
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const resp = await fetch("https://registry.npmjs.org/@synapse/cli/latest", {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) return null;
    const data = await resp.json();
    return data.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

function readCache(): VersionCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(cache: VersionCache): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch {
    // Non-critical
  }
}

function printUpdateNotice(current: string, latest: string): void {
  process.stderr.write(
    `\n  Update available: ${current} → ${latest}  Run \`synapse update\` to upgrade\n\n`,
  );
}
