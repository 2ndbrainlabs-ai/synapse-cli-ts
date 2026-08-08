// src/backend/endpoint-namer.ts
//
// Local auto-mode naming pass. Endpoint route/method alone is a weak signal
// for agentic tool selection ("post_orders_id_cancel" tells an LLM caller
// nothing about side effects or validation). This reads each handler's
// actual source off disk (plus repo README/docs context, see repo-context.ts)
// and asks Haiku to name/describe it from real behavior — so the tool a
// user gets still reads well even with zero docstrings or comments in the
// source project.
//
// The `buildEndpointContext`/MAX_HANDLER_CHARS helpers here are also used to
// shape the NameEndpointsRequest sent to the hosted backend for non-local
// `--auto --smart-names` builds (see auto-flow.ts), so the local and hosted
// paths read the exact same source window and produce comparably-shaped
// output — only where the LLM call itself runs differs.
//
// Best-effort: on any failure (read error, API error, malformed response)
// callers fall back to the extractor's mechanical suggested_tool_name /
// docstring-derived description — never blocks the build.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { call, extractToolUse } from "./anthropic-call.js";
import { ENDPOINT_NAMER_SYSTEM_PROMPT } from "./prompts.js";
import { EMIT_ENDPOINT_NAMES_TOOL, EndpointNameSchema } from "./schemas.js";
import type { HttpEndpoint } from "../extractors/core/surface-manifest.js";

export const MAX_HANDLER_CHARS = 3000;
const MAX_ENDPOINTS_PER_CALL = 30;

export interface EndpointNameResult {
  tool_name: string;
  description: string;
}

export interface EndpointContext {
  index: number;
  method: string;
  path: string;
  handler_qualname: string;
  existing_description: string;
  handler_source: string;
}

export function readHandlerSource(workingDir: string, ep: HttpEndpoint): string {
  try {
    const abs = path.join(workingDir, ep.file_path);
    const lines = fs.readFileSync(abs, "utf-8").split("\n");
    const snippet = lines.slice(ep.start_line - 1, ep.end_line).join("\n");
    return snippet.length > MAX_HANDLER_CHARS
      ? snippet.slice(0, MAX_HANDLER_CHARS) + "\n# …truncated"
      : snippet;
  } catch {
    return "";
  }
}

/** Same context shape consumed by the local LLM call and sent over gRPC for hosted. */
export function buildEndpointContexts(
  endpoints: HttpEndpoint[],
  workingDir: string,
): EndpointContext[] {
  return endpoints.map((ep, index) => ({
    index,
    method: ep.method,
    path: ep.path,
    handler_qualname: ep.handler_qualname,
    existing_description: ep.description || "",
    handler_source: readHandlerSource(workingDir, ep) || "",
  }));
}

/**
 * Generates tool_name + description for each endpoint from its handler's
 * real source (already embedded in each EndpointContext.handler_source),
 * plus repo README/docs context if provided. Returns a Map keyed by the
 * endpoint's position in `endpoints`. Missing/failed entries are simply
 * absent from the map — callers should fall back to the endpoint's own
 * suggested_tool_name/description.
 */
export async function nameAndDescribeEndpoints(opts: {
  client: Anthropic;
  endpoints: EndpointContext[];
  sessionId: string;
  readmeContext?: string;
  cliVersion?: string;
  installationId?: string;
  onStatus?: (stage: string, message: string, progress: number) => void;
}): Promise<Map<number, EndpointNameResult>> {
  const results = new Map<number, EndpointNameResult>();
  if (opts.endpoints.length === 0) return results;

  const contexts = opts.endpoints;
  const batches: EndpointContext[][] = [];
  for (let i = 0; i < contexts.length; i += MAX_ENDPOINTS_PER_CALL) {
    batches.push(contexts.slice(i, i + MAX_ENDPOINTS_PER_CALL));
  }

  const readmeBlock = opts.readmeContext
    ? `Repo context (README/docs excerpt):\n${opts.readmeContext}\n\n`
    : "";

  let offset = 0;
  for (const batch of batches) {
    const batchOffset = offset;
    offset += batch.length;

    // Re-index each batch to 0..N-1 for the model; map back via batchOffset.
    const payload = batch.map((ctx, i) => ({
      index: i,
      method: ctx.method,
      path: ctx.path,
      handler_qualname: ctx.handler_qualname,
      existing_docstring: ctx.existing_description,
      source: ctx.handler_source || "<source unavailable>",
    }));

    try {
      opts.onStatus?.("naming", "Reading handlers to name tools", 0.5);
      const msg = await call({
        client: opts.client,
        task: "triage",
        sessionId: opts.sessionId,
        system: ENDPOINT_NAMER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `${readmeBlock}Endpoints:\n${JSON.stringify(payload, null, 2)}`,
          },
        ],
        tools: [EMIT_ENDPOINT_NAMES_TOOL],
        toolChoice: { type: "tool", name: "emit_endpoint_names" },
        cliVersion: opts.cliVersion,
        installationId: opts.installationId,
      });

      const raw = extractToolUse(msg, "emit_endpoint_names");
      const names = (raw?.names as unknown[]) ?? [];
      for (const entry of names) {
        const parsed = EndpointNameSchema.safeParse(entry);
        if (!parsed.success) continue;
        const { index, tool_name, description } = parsed.data;
        if (index < 0 || index >= batch.length) continue;
        results.set(batchOffset + index, { tool_name, description });
      }
    } catch {
      // Best-effort — leave this batch's entries out of the map so callers
      // fall back to the mechanical name/description.
    }
  }

  return results;
}
