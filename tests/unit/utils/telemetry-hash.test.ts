// installation_id / working_dir_hash are keyed with a per-install salt
// (SYN-367) instead of plain sha256, so they can't be guessed.

import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GLOBAL_SYNAPSE_DIR } from "../../../src/config/paths.js";
import {
  SALT_FILE,
  resetTelemetrySaltCache,
  telemetryHash,
  telemetrySalt,
} from "../../../src/utils/telemetry-hash.js";

const saltFile = path.join(GLOBAL_SYNAPSE_DIR, SALT_FILE);
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("telemetry salt", () => {
  beforeEach(() => {
    fs.rmSync(saltFile, { force: true });
    resetTelemetrySaltCache();
  });

  it("never touches the real home directory under test", () => {
    expect(GLOBAL_SYNAPSE_DIR.startsWith(os.tmpdir()) || GLOBAL_SYNAPSE_DIR.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  });

  it("creates a private 32-byte salt on first use", () => {
    const salt = telemetrySalt();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(saltFile, "utf-8").trim()).toBe(salt);
    expect(fs.statSync(saltFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(GLOBAL_SYNAPSE_DIR).filter((f) => f.startsWith(`${SALT_FILE}.`))).toEqual([]);
  });

  it("keeps the same salt, and so the same ids, across runs", () => {
    const first = telemetryHash("host@user");
    resetTelemetrySaltCache();
    expect(telemetryHash("host@user")).toBe(first);
  });

  it("is an HMAC, not the guessable plain sha256", () => {
    const id = telemetryHash("host@user");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(sha256("host@user"));
    expect(id).toBe(crypto.createHmac("sha256", telemetrySalt()).update("host@user").digest("hex"));
  });

  it("gives different ids on different installs", () => {
    const a = telemetryHash("/home/me/project");
    fs.rmSync(saltFile);
    resetTelemetrySaltCache();
    expect(telemetryHash("/home/me/project")).not.toBe(a);
  });

  it("replaces a corrupt salt file", () => {
    fs.mkdirSync(GLOBAL_SYNAPSE_DIR, { recursive: true });
    fs.writeFileSync(saltFile, "not-a-salt");
    const salt = telemetrySalt();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(saltFile, "utf-8").trim()).toBe(salt);
  });

  it("keeps an existing salt written by another run", () => {
    fs.mkdirSync(GLOBAL_SYNAPSE_DIR, { recursive: true });
    const existing = "a".repeat(64);
    fs.writeFileSync(saltFile, existing + "\n");
    expect(telemetrySalt()).toBe(existing);
  });
});
