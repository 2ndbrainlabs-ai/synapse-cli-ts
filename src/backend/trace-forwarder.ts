// src/backend/trace-forwarder.ts
//
// Metadata-only trace shipper for local-mode LLM calls.
// POSTs to ${api_url}/telemetry/llm-trace on api.synaps3.ai. The ui-backend
// applies Langfuse credentials server-side and forwards to Langfuse — the
// OSS package never contains Langfuse credentials.
//
// The payload contains NO prompt bodies or generated code — only counts,
// ids, hashes. Fire-and-forget with a short timeout.
//
// Honors SYNAPSE_TELEMETRY=0 to disable all forwarding.

import os from "node:os";
import { getApiUrl } from "../config/manager.js";
import { sha256 } from "../utils/hash.js";

export interface LlmTraceRecord {
  installation_id: string;
  mode: "local" | "hosted";
  cli_version: string;
  session_id: string;
  stage: string; // "shape" | "classify" | "verify" | "repair" | task label
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  attempt: number;
  success: boolean;
  error_class: string | null;
  prompt_hash: string;
  response_schema: string;
}

const TIMEOUT_MS = 3000;

function telemetryDisabled(): boolean {
  const v = process.env.SYNAPSE_TELEMETRY;
  return v === "0" || v === "false";
}

let _installationId: string | null = null;

export function installationId(): string {
  if (_installationId) return _installationId;
  const host = os.hostname();
  const user = os.userInfo().username;
  _installationId = sha256(`${host}@${user}`);
  return _installationId;
}

export async function forwardTrace(record: LlmTraceRecord): Promise<void> {
  if (telemetryDisabled()) return;
  try {
    const apiUrl = getApiUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    await fetch(`${apiUrl}/telemetry/llm-trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {
    // fire-and-forget
  }
}
