// src/extractors/core/surface-manifest.ts
//
// SurfaceManifest — the deterministic artifact produced by the CLI extractor
// and consumed by BOTH tracks of `synapse build` (Auto → ui-backend; Custom → gRPC backend).
//
// Same repo hash → identical manifest. No LLM involved.

export type SupportedLanguage =
  | "python"
  | "typescript"
  | "javascript"
  | "java"
  | "csharp"
  | "go"
  | "rust";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Header {
  key: string;
  value: string;
}

/** An HTTP endpoint discovered by the extractor — feeds Auto mode. */
export interface HttpEndpoint {
  method: HttpMethod;
  /** Route path only, e.g. "/orders/{id}/cancel". No scheme, no host. */
  path: string;
  /** Dotted module path of the handler, e.g. "app.routes.orders". */
  handler_module: string;
  /** Function name, e.g. "cancel_order". */
  handler_qualname: string;
  /** Docstring-derived description; empty string if none. */
  description: string;
  /** Example request body if the handler declares a typed body; null otherwise. */
  payload_example: Record<string, unknown> | null;
  /** Headers the endpoint needs (e.g. Authorization) with `${ENV_VAR}` placeholders. */
  headers_hint: Header[];
  /** snake_case tool name derived from method + path/handler. */
  suggested_tool_name: string;
}

/** A public function discovered by the extractor — feeds Custom mode. */
export interface SurfaceFunction {
  /** Dotted module path, e.g. "user_app.services.posts". */
  module: string;
  /** Function name (no dots, no class prefix in M1). */
  qualname: string;
  /** Full signature line, e.g. "async def validate(body: str) -> ValidationResult". */
  signature: string;
  docstring: string;
  is_async: boolean;
  is_public: boolean;
  file_path: string; // repo-relative
  start_line: number;
  end_line: number;
}

export interface SurfaceManifest {
  language: SupportedLanguage;
  framework: string | null;
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
  /** Root package name used to build import paths, e.g. "app" or "user_app". */
  package_import_root: string;
  /** True when the scan was aborted (sigint / deadline). Custom-mode LLM steps
   *  should NOT be invoked on partial manifests. */
  partial?: boolean;
  /** Custom-mode ranked tail: candidates below the top-K score bar. The CLI
   *  can offer "show more" here if the user wants a wider pick. */
  background_functions?: SurfaceFunction[];
}

// -----------------------------------------------------------------------------
// Runtime validation (hand-rolled — zod is not in the CLI's dependency set)
// -----------------------------------------------------------------------------

export function isHttpMethod(m: string): m is HttpMethod {
  return m === "GET" || m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

export function validateManifest(m: unknown): m is SurfaceManifest {
  if (!m || typeof m !== "object") return false;
  const x = m as SurfaceManifest;
  return (
    typeof x.language === "string" &&
    (x.framework === null || typeof x.framework === "string") &&
    Array.isArray(x.endpoints) &&
    Array.isArray(x.functions) &&
    typeof x.package_import_root === "string"
  );
}
