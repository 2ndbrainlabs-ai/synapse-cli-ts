// dotenv is loaded via "dotenv/config" import in index.ts
// This module provides helpers for .env file manipulation

import fs from "node:fs";
import path from "node:path";

export function readDotenv(dotenvPath: string): Record<string, string> {
  if (!fs.existsSync(dotenvPath)) return {};
  const lines = fs.readFileSync(dotenvPath, "utf-8").split("\n");
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function appendDotenv(
  dotenvPath: string,
  vars: Record<string, string>,
): number {
  let written = 0;
  const existing = readDotenv(dotenvPath);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    if (key in existing) continue;
    const needsQuotes = /[\s#="']/.test(value);
    lines.push(needsQuotes ? `${key}="${value}"` : `${key}=${value}`);
    written++;
  }

  if (lines.length > 0) {
    const prefix = fs.existsSync(dotenvPath) ? "\n" : "";
    fs.appendFileSync(dotenvPath, prefix + lines.join("\n") + "\n", "utf-8");
  }
  return written;
}
