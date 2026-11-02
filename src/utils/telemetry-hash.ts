// src/utils/telemetry-hash.ts
//
// Keyed hashes for telemetry ids (SYN-367).
//
// installation_id and working_dir_hash used to be plain sha256 of
// `host@user` and the absolute path, so anyone with a guess could confirm
// it. They are now HMAC-SHA256 keyed with a random per-install salt kept in
// the global config dir (~/.synapse/telemetry-salt, mode 0600). The salt is
// created on first use and never sent, so installation_id stays stable per
// machine but can't be reversed or confirmed. Ids changed once, on the first
// run of the version that introduced this.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GLOBAL_SYNAPSE_DIR } from "../config/paths.js";

export const SALT_FILE = "telemetry-salt";
const SALT_RE = /^[0-9a-f]{64}$/;

let _salt: string | null = null;

function saltPath(): string {
  return path.join(GLOBAL_SYNAPSE_DIR, SALT_FILE);
}

function readSalt(file: string): string | null {
  try {
    const v = fs.readFileSync(file, "utf-8").trim();
    return SALT_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The per-install salt: read it, or create it on first use. If the config
 *  dir isn't writable, a random salt is used for this process only — ids are
 *  then not stable across runs, but still never guessable. */
export function telemetrySalt(): string {
  if (_salt) return _salt;
  const file = saltPath();
  let salt = readSalt(file);
  if (!salt) {
    const fresh = crypto.randomBytes(32).toString("hex");
    try {
      fs.mkdirSync(GLOBAL_SYNAPSE_DIR, { recursive: true });
      // Write a temp file, then hard-link it into place: link() fails if the
      // file already exists, so two concurrent first runs agree on one salt.
      // A corrupt file (not 64 hex chars) is replaced.
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmp, fresh + "\n", { mode: 0o600 });
      try {
        if (fs.existsSync(file) && !readSalt(file)) fs.rmSync(file, { force: true });
        fs.linkSync(tmp, file);
      } catch {
        /* another run won the race — read its salt below */
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      salt = readSalt(file) ?? fresh;
    } catch {
      salt = fresh;
    }
  }
  _salt = salt;
  return salt;
}

/** HMAC-SHA256 (hex) of `input`, keyed with the per-install salt. */
export function telemetryHash(input: string): string {
  return crypto.createHmac("sha256", telemetrySalt()).update(input, "utf-8").digest("hex");
}

/** Test hook: forget the cached salt. */
export function resetTelemetrySaltCache(): void {
  _salt = null;
}
