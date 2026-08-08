// src/backend/candidate-classifier.ts
//
// Haiku fan-out over SurfaceManifest.functions. Sharded per-N, one Haiku
// call per shard via Promise.all. Returns FunctionVerdict[].
//
// No Firestore cache (Python has one; local runs are infrequent enough
// that a cache costs more than it saves).

import Anthropic from "@anthropic-ai/sdk";
import { call, extractToolUse } from "./anthropic-call.js";
import { CANDIDATE_CLASSIFIER_SYSTEM_PROMPT } from "./prompts.js";
import {
  EMIT_SHARD_VERDICTS_TOOL,
  FunctionVerdictSchema,
  type FunctionVerdict,
} from "./schemas.js";
import type {
  SurfaceFunction,
  SurfaceManifest,
} from "../extractors/core/surface-manifest.js";

export interface ClassifyResult {
  verdicts: FunctionVerdict[];
  shards_run: number;
  budget_dropped: number;
  error: string;
}

export interface ClassifyOptions {
  client: Anthropic;
  manifest: SurfaceManifest;
  sessionId: string;
  shardSize?: number;
  maxShards?: number;
  perShardTimeoutMs?: number;
  onStatus?: (stage: string, msg: string, progress: number) => Promise<void> | void;
  cliVersion?: string;
  installationId?: string;
}

function summarizeFunction(f: SurfaceFunction): Record<string, unknown> {
  const doc = (f.docstring || "").replace(/\n/g, " ").slice(0, 200).trim();
  return {
    qualname: f.qualname,
    module: f.module,
    signature: f.signature.slice(0, 180),
    docstring: doc,
    is_async: f.is_async,
    file_path: f.file_path,
  };
}

function lowDefault(fns: SurfaceFunction[]): FunctionVerdict[] {
  return fns.map((f) => ({
    qualname: f.qualname,
    band: "LOW" as const,
    tool_shape: "" as const,
    workflow_hints: [],
    one_line_purpose: "",
  }));
}

async function runShard(
  client: Anthropic,
  shardId: number,
  functions: SurfaceFunction[],
  sessionId: string,
  timeoutMs: number,
  cliVersion?: string,
  installationId?: string,
): Promise<FunctionVerdict[]> {
  const payload = { functions: functions.map(summarizeFunction) };
  const userContent =
    "Classify each function below. Return via emit_shard_verdicts.\n\n" +
    "```json\n" +
    JSON.stringify(payload, null, 2) +
    "\n```";

  const system = [
    {
      type: "text" as const,
      text: CANDIDATE_CLASSIFIER_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  let msg;
  try {
    msg = await Promise.race([
      call({
        client,
        task: "triage",
        sessionId,
        system,
        messages: [{ role: "user", content: userContent }],
        tools: [EMIT_SHARD_VERDICTS_TOOL],
        toolChoice: { type: "tool", name: EMIT_SHARD_VERDICTS_TOOL.name },
        cliVersion,
        installationId,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("shard-timeout")), timeoutMs),
      ),
    ]);
  } catch (e) {
    void e;
    void shardId;
    return lowDefault(functions);
  }

  const input = extractToolUse(msg, EMIT_SHARD_VERDICTS_TOOL.name);
  if (!input) return lowDefault(functions);

  const parsed: FunctionVerdict[] = [];
  const rawVerdicts = (input.verdicts as unknown[]) ?? [];
  for (const entry of rawVerdicts) {
    const r = FunctionVerdictSchema.safeParse(entry);
    if (r.success) parsed.push(r.data);
  }

  // Ensure every input function is represented — LOW fallback for anything dropped.
  const seen = new Set(parsed.map((v) => v.qualname));
  for (const f of functions) {
    if (!seen.has(f.qualname)) {
      parsed.push({
        qualname: f.qualname,
        band: "LOW",
        tool_shape: "",
        workflow_hints: [],
        one_line_purpose: "",
      });
    }
  }
  return parsed;
}

export async function classifyCandidates(
  opts: ClassifyOptions,
): Promise<ClassifyResult> {
  const functions = opts.manifest.functions;
  if (functions.length === 0) {
    return { verdicts: [], shards_run: 0, budget_dropped: 0, error: "" };
  }

  const shardSize = opts.shardSize && opts.shardSize > 0 ? opts.shardSize : 12;
  const maxShards = opts.maxShards && opts.maxShards > 0 ? opts.maxShards : 20;
  const timeoutMs = opts.perShardTimeoutMs ?? 30_000;

  const shards: SurfaceFunction[][] = [];
  for (let i = 0; i < functions.length; i += shardSize) {
    shards.push(functions.slice(i, i + shardSize));
  }

  let budgetDropped = 0;
  let dropped: SurfaceFunction[] = [];
  if (shards.length > maxShards) {
    dropped = shards.slice(maxShards).flat();
    shards.length = maxShards;
    budgetDropped = dropped.length;
  }

  if (opts.onStatus) {
    const total = shards.reduce((n, s) => n + s.length, 0);
    await opts.onStatus(
      "classifying",
      `Classifying ${total} functions across ${shards.length} shards`,
      0.3,
    );
  }

  const shardResults = await Promise.all(
    shards.map((batch, i) =>
      runShard(
        opts.client,
        i,
        batch,
        opts.sessionId,
        timeoutMs,
        opts.cliVersion,
        opts.installationId,
      ),
    ),
  );

  const verdicts: FunctionVerdict[] = shardResults.flat();
  for (const f of dropped) {
    verdicts.push({
      qualname: f.qualname,
      band: "LOW",
      tool_shape: "",
      workflow_hints: [],
      one_line_purpose: "",
    });
  }

  return {
    verdicts,
    shards_run: shards.length,
    budget_dropped: budgetDropped,
    error: "",
  };
}
