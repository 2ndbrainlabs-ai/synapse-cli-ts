import crypto from "node:crypto";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}
