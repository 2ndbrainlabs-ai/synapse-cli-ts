// src/extractors/core/manifest-wire.ts
//
// Serialise the SurfaceManifest for gRPC transport. Trims fields the backend
// doesn't need to see and caps oversized strings so we don't blow the
// default gRPC 4 MB message ceiling on large repos.
//
// Fields kept:
//   language, framework, package_import_root, partial
//   endpoints[]  (all fields, description clipped to 400 chars)
//   functions[]  (module, qualname, signature clipped to 240, docstring clipped to 200,
//                 is_async, is_public, file_path, start_line)
//
// Fields dropped:
//   background_functions[]  — CLI-side only, not needed for classify/shape
//   end_line                — not used by the LLM
//   headers_hint            — kept for endpoints (used by runner)
//   stats                   — CLI-side telemetry
//   Any RankedFunction extras (score, call_site_count) — kept because
//   they're small and the classifier can use them as hints.

import type { SurfaceManifest } from "./surface-manifest.js";

function clip(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const MAX_DOCSTRING = 200;
const MAX_DESCRIPTION = 400;
const MAX_SIGNATURE = 240;

export interface WireManifest {
  language: SurfaceManifest["language"];
  framework: SurfaceManifest["framework"];
  package_import_root: string;
  partial?: boolean;
  endpoints: Array<{
    method: string;
    path: string;
    handler_module: string;
    handler_qualname: string;
    description: string;
    payload_example: Record<string, unknown> | null;
    headers_hint: { key: string; value: string }[];
    suggested_tool_name: string;
  }>;
  functions: Array<{
    module: string;
    qualname: string;
    signature: string;
    docstring: string;
    is_async: boolean;
    is_public: boolean;
    file_path: string;
    start_line: number;
    // Optional classifier hints — carried when present.
    score?: number;
    call_site_count?: number;
  }>;
}

export function serializeManifestForWire(manifest: SurfaceManifest): string {
  const wire: WireManifest = {
    language: manifest.language,
    framework: manifest.framework,
    package_import_root: manifest.package_import_root,
    partial: manifest.partial,
    endpoints: manifest.endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      handler_module: e.handler_module,
      handler_qualname: e.handler_qualname,
      description: clip(e.description, MAX_DESCRIPTION),
      payload_example: e.payload_example ?? null,
      headers_hint: e.headers_hint ?? [],
      suggested_tool_name: e.suggested_tool_name,
    })),
    functions: manifest.functions.map((f) => {
      const anyF = f as { score?: number; call_site_count?: number };
      return {
        module: f.module,
        qualname: f.qualname,
        signature: clip(f.signature, MAX_SIGNATURE),
        docstring: clip(f.docstring, MAX_DOCSTRING),
        is_async: f.is_async,
        is_public: f.is_public,
        file_path: f.file_path,
        start_line: f.start_line,
        ...(anyF.score != null ? { score: anyF.score } : {}),
        ...(anyF.call_site_count != null ? { call_site_count: anyF.call_site_count } : {}),
      };
    }),
  };
  return JSON.stringify(wire);
}

/** Estimate the serialized byte length without doing the JSON pass twice. */
export function estimateWireBytes(manifest: SurfaceManifest): number {
  return serializeManifestForWire(manifest).length;
}
