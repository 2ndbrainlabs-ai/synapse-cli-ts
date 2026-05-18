// src/builder/endpoint-detector.ts
//
// Simplified local AST-based fallback for endpoint detection.
// Port of Python's `utils/endpoint_detector.py`.
//
// Used when the gRPC DetectEndpoints RPC fails. The real detection
// happens on the backend via the DetectEndpoints RPC which uses
// LLM-based classification. This local fallback is intentionally
// minimal — it just marks all extracted functions as low-confidence
// candidates so the user can still select them manually.

import path from "node:path";

/**
 * Local fallback endpoint detection.
 *
 * Returns an empty array — the real detection uses the backend's
 * DetectEndpoints RPC. This stub exists so the build flow can
 * degrade gracefully if the backend is unreachable.
 *
 * If needed, it can be expanded to use the function extractor
 * and apply simple heuristics (e.g., presence of HTTP decorators,
 * docstrings, parameter types) to rank candidates locally.
 */
export function detectEndpointsLocal(_workingDir: string): any[] {
  return [];
}

/**
 * Convert extracted FunctionInfo objects to low-confidence candidates.
 *
 * This is the fallback path when DetectEndpoints RPC fails: instead of
 * returning nothing, mark all extracted functions as candidates with
 * 0.0 confidence so the user can browse and select them in the TUI.
 */
export function functionsToFallbackCandidates(
  functions: any[],
  _workingDir: string,
): any[] {
  return functions.map((fn) => ({
    name: fn.name ?? "",
    file_path: fn.filePath ?? fn.file_path ?? "",
    confidence: 0.0,
    human_title: fn.name ?? "",
    human_description: fn.docstring
      ? fn.docstring.slice(0, 120)
      : `Function in ${path.basename(fn.filePath ?? fn.file_path ?? "")}`,
    conversion_type: fn.endpointType === "method" ? "class_method" : "ready",
    client_dependency_json: "",
    subcategory: "unknown",
    signature: fn.signature ?? "",
    docstring: fn.docstring ?? "",
    line_number: fn.lineNumber ?? fn.line_number ?? 0,
  }));
}
