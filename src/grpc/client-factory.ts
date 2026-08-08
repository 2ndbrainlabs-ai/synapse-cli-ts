// src/grpc/client-factory.ts
//
// Factory returning the right ISynapseClient impl based on effective mode.
// - "hosted"  → SynapseClient (this file's neighbor, talks gRPC to grpc.synaps3.ai)
// - "local"   → LocalSynapseClient (src/backend/index.ts, in-process TS pipeline)

import { SynapseClient } from "./client.js";
import { LocalSynapseClient } from "../backend/index.js";
import type { CustomBuildResult, ClassifyResult, NameEndpointsResult } from "../backend/index.js";
import type { EndpointContext } from "../backend/endpoint-namer.js";

export type EffectiveMode = "hosted" | "local";

/**
 * Common surface across the hosted and local clients — the two impls have
 * matching public methods; this interface pins the shape so command code
 * doesn't care which one it's holding.
 */
export interface ISynapseClient {
  buildCustom(opts: {
    language: string;
    manifestJson: string;
    intent: string;
    selectedQualnames?: string[];
    suggestedToolName?: string;
    sessionId?: string;
    onStatus?: (stage: string, message: string, progress: number) => void;
  }): Promise<CustomBuildResult>;

  classifyCandidates(opts: {
    manifestJson: string;
    shardSize?: number;
    maxShards?: number;
    sessionId?: string;
    signal?: AbortSignal;
    onStatus?: (stage: string, message: string, progress: number) => void;
    timeoutMs?: number;
  }): Promise<ClassifyResult>;

  /** --smart-names: name/describe endpoints from real handler source (+ readme context). */
  nameEndpoints(opts: {
    endpoints: EndpointContext[];
    workingDir: string;
    readmeContext?: string;
    sessionId?: string;
    signal?: AbortSignal;
    onStatus?: (stage: string, message: string, progress: number) => void;
    timeoutMs?: number;
  }): Promise<NameEndpointsResult>;

  close(): Promise<void>;
}

export interface FactoryOpts {
  effectiveMode: EffectiveMode;
  workingDir?: string;
  /** Required when effectiveMode === "local". */
  anthropicKey?: string;
}

export function makeSynapseClient(opts: FactoryOpts): ISynapseClient {
  if (opts.effectiveMode === "local") {
    if (!opts.anthropicKey) {
      throw new Error(
        "Local mode requires an Anthropic API key. " +
          "Set ANTHROPIC_API_KEY or pass --anthropic-key.",
      );
    }
    return new LocalSynapseClient({
      anthropicKey: opts.anthropicKey,
      workingDir: opts.workingDir,
    }) as unknown as ISynapseClient;
  }

  return new SynapseClient({
    workingDir: opts.workingDir,
  }) as unknown as ISynapseClient;
}
