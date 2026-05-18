import crypto from "node:crypto";
import os from "node:os";

const PBKDF2_SALT = Buffer.from("synapse-salt-v1", "utf-8");
const PBKDF2_ITERATIONS = 100_000;
const VERSION_TAG = "synapse-cli-v1";

let cachedKey: Buffer | null = null;

function deriveMachineKey(): Buffer {
  if (cachedKey) return cachedKey;

  const user = os.userInfo().username;
  const hostname = os.hostname();
  // Python's platform.node() returns the same as socket.gethostname()
  const node = hostname;
  const seed = `${user}@${hostname}:${node}:${VERSION_TAG}`;

  const raw = crypto.pbkdf2Sync(
    Buffer.from(seed, "utf-8"),
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    32,
    "sha256",
  );

  // Fernet requires a 32-byte url-safe base64 key
  cachedKey = Buffer.from(raw.toString("base64url") + "=", "ascii");
  return cachedKey;
}

function fernetEncrypt(key: Buffer, plaintext: Buffer): string {
  // Fernet v0x80: version(1) + timestamp(8) + iv(16) + ciphertext(N) + hmac(32)
  const version = Buffer.from([0x80]);
  const timestamp = Buffer.alloc(8);
  const now = BigInt(Math.floor(Date.now() / 1000));
  timestamp.writeBigUInt64BE(now);

  const iv = crypto.randomBytes(16);

  // Fernet key = first 16 bytes for HMAC, last 16 bytes for AES
  const fernetKeyBytes = Buffer.from(key.toString("ascii"), "base64url");
  const signingKey = fernetKeyBytes.subarray(0, 16);
  const encryptionKey = fernetKeyBytes.subarray(16, 32);

  // AES-128-CBC
  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // HMAC-SHA256 over version + timestamp + iv + ciphertext
  const payload = Buffer.concat([version, timestamp, iv, encrypted]);
  const hmac = crypto.createHmac("sha256", signingKey).update(payload).digest();

  const token = Buffer.concat([payload, hmac]);
  return token.toString("base64url") + "=";
}

function fernetDecrypt(key: Buffer, token: string): Buffer {
  // Decode the base64url token
  const tokenBytes = Buffer.from(token, "base64url");

  if (tokenBytes.length < 57) {
    throw new Error("Invalid Fernet token");
  }

  const version = tokenBytes[0];
  if (version !== 0x80) {
    throw new Error("Invalid Fernet token version");
  }

  const iv = tokenBytes.subarray(9, 25);
  const ciphertext = tokenBytes.subarray(25, tokenBytes.length - 32);
  const hmacReceived = tokenBytes.subarray(tokenBytes.length - 32);

  // Verify HMAC
  const fernetKeyBytes = Buffer.from(key.toString("ascii"), "base64url");
  const signingKey = fernetKeyBytes.subarray(0, 16);
  const encryptionKey = fernetKeyBytes.subarray(16, 32);

  const payload = tokenBytes.subarray(0, tokenBytes.length - 32);
  const hmacComputed = crypto
    .createHmac("sha256", signingKey)
    .update(payload)
    .digest();

  if (!crypto.timingSafeEqual(hmacReceived, hmacComputed)) {
    throw new Error("HMAC verification failed");
  }

  // Decrypt AES-128-CBC
  const decipher = crypto.createDecipheriv("aes-128-cbc", encryptionKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptApiKey(rawKey: string): [string, string] {
  rawKey = (rawKey || "").trim();
  if (!rawKey) {
    throw new Error("API key cannot be empty");
  }

  const prefix = rawKey.length >= 5 ? rawKey.slice(0, 5) : rawKey;
  const key = deriveMachineKey();
  const encrypted = fernetEncrypt(key, Buffer.from(rawKey, "utf-8"));
  return [prefix, encrypted];
}

export function decryptApiKey(encrypted: string): string {
  if (!encrypted || !encrypted.trim()) {
    throw new Error("Encrypted key is empty");
  }

  const key = deriveMachineKey();
  try {
    return fernetDecrypt(key, encrypted.trim()).toString("utf-8");
  } catch {
    throw new Error(
      "API key could not be decrypted on this machine.\n" +
        "This usually means the config was created on a different machine or " +
        "your machine identity has changed (e.g. hostname, username, or " +
        "container environment).\n" +
        "Run `synapse init` to re-enter your API key.",
    );
  }
}

export function formatApiKeyDisplay(prefix: string): string {
  if (!prefix) return "(not set)";
  return prefix + "*".repeat(Math.max(0, 20 - prefix.length));
}
