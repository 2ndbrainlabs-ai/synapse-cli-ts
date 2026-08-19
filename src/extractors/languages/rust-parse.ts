// src/extractors/languages/rust-parse.ts
//
// Pure tree-sitter parse for a single Rust file.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type TreeSitter from "tree-sitter";
import type { HttpEndpoint, HttpMethod, SurfaceFunction, SurfaceManifest } from "../core/surface-manifest.js";
import { isHttpMethod } from "../core/surface-manifest.js";

const require = createRequire(import.meta.url);

let _parser: TreeSitter | null = null;
function getParser(): TreeSitter {
  if (_parser) return _parser;
  const TS = require("tree-sitter");
  const Rust = require("tree-sitter-rust");
  const p = new TS();
  p.setLanguage(Rust);
  _parser = p;
  return p;
}

export const FRAMEWORK_SIGNATURES = [
  { name: "actix",   hints: ["actix-web", "actix_web", "use actix", "HttpServer::new"] },
  { name: "rocket",  hints: ["rocket", "#[rocket", "rocket::build"] },
  { name: "axum",    hints: ["axum", "Router::new", "axum::Router"] },
  { name: "poem",    hints: ["poem", "poem_openapi", "Route::new"] },
  { name: "warp",    hints: ["warp", "warp::path", "warp::filter"] },
  { name: "tide",    hints: ["tide", "tide::new"] },
  { name: "salvo",   hints: ["salvo", "salvo_core"] },
  { name: "loco",    hints: ["loco_rs", "loco::prelude"] },
];

// Noir's Rust HTTP_VERBS — matches both attribute macro names and Axum handler functions
const ROUTE_ATTR_RE = /#\[(?:actix_web::|rocket::)?(?:route\s*\([^,)]+,\s*method\s*=\s*)?(?:HttpMethod\s*::\s*)?(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"/i;
// Generic #[route("/path", method="GET")] form
const GENERIC_ROUTE_ATTR_RE = /#\[(?:actix_web::)?route\s*\(\s*"([^"]+)"[^)]*(?:method\s*=\s*(?:HttpMethod::)?["']?([A-Z]+)["']?)?/i;
// Axum: .route("/path", get(handler)) — also handles multi-method chaining
const AXUM_ROUTE_RE = /\.route\s*\(\s*"([^"]+)"\s*,\s*((?:get|post|put|patch|delete|head|options)\s*\()/i;
// Poem: Route::new().at("/path", get(handler))
const POEM_AT_RE = /\.at\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(/i;

function suggestToolName(method: HttpMethod, routePath: string, handlerName: string): string {
  const generic = new Set(["handler", "handle", "index", "root", "endpoint"]);
  if (handlerName && !generic.has(handlerName.toLowerCase())) return handlerName.slice(0, 60);
  const cleaned = routePath
    .replace(/^\/+|\/+$/g, "")
    .replace(/[:][^/]+/g, "by_param")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase();
  const verb = method === "GET" ? "get" : method === "POST" ? "create" :
               method === "PUT" ? "update" : method === "PATCH" ? "patch" : "delete";
  const base = cleaned || handlerName || "route";
  return `${verb}_${base}`.slice(0, 60);
}

function getNodeText(node: TreeSitter.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function collectAttributes(node: TreeSitter.SyntaxNode, source: string): string[] {
  const attrs: string[] = [];
  // Check children of the node first (tree-sitter-rust embeds attrs as children)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "attribute_item" || child.type === "outer_attribute_item") {
      attrs.push(getNodeText(child, source));
    }
  }
  if (attrs.length > 0) return attrs;
  // Fallback: find this node's index among siblings, then collect only the
  // immediately preceding attribute_item block (stopping on any non-attribute).
  const parent = node.parent;
  if (!parent) return attrs;
  let nodeIdx = -1;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i) === node) { nodeIdx = i; break; }
  }
  if (nodeIdx <= 0) return attrs;
  for (let i = nodeIdx - 1; i >= 0; i--) {
    const sib = parent.child(i)!;
    if (sib.type === "attribute_item" || sib.type === "outer_attribute_item") {
      attrs.unshift(getNodeText(sib, source));
    } else {
      break; // stop at first non-attribute sibling
    }
  }
  return attrs;
}

function walkNode(
  node: TreeSitter.SyntaxNode,
  source: string,
  relPath: string,
  moduleDotted: string,
  endpoints: HttpEndpoint[],
  functions: SurfaceFunction[],
): void {
  // Actix/Rocket: fn with #[get("/path")] attribute
  if (node.type === "function_item") {
    const attrs = collectAttributes(node, source);
    let route: { method: HttpMethod; path: string } | null = null;

    for (const attr of attrs) {
      // Standard verb attribute: #[get("/path")], #[actix_web::post("/path")]
      const m = attr.match(ROUTE_ATTR_RE);
      if (m) {
        const method = m[1].toUpperCase() as HttpMethod;
        route = { method: isHttpMethod(method) ? method : "GET", path: m[2] };
        break;
      }
      // Generic #[route("/path", method="GET")]
      const mg = attr.match(GENERIC_ROUTE_ATTR_RE);
      if (mg) {
        const method = (mg[2] ?? "GET").toUpperCase() as HttpMethod;
        route = { method: isHttpMethod(method) ? method : "GET", path: mg[1] };
        break;
      }
    }

    const raw = getNodeText(node, source);
    const nameMatch = raw.match(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
    const handlerName = nameMatch ? nameMatch[1] : "";

    if (route) {
      endpoints.push({
        method: route.method,
        path: route.path,
        handler_module: moduleDotted,
        handler_qualname: handlerName,
        description: "",
        payload_example: null,
        headers_hint: [],
        suggested_tool_name: suggestToolName(route.method, route.path, handlerName),
        file_path: relPath,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      });
    } else if (raw.includes("pub ") || raw.includes("pub(")) {
      functions.push({
        module: moduleDotted,
        qualname: handlerName,
        signature: raw.split("\n")[0].trim().slice(0, 200),
        docstring: "",
        is_async: raw.includes("async fn"),
        is_public: true,
        file_path: relPath,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      });
    }
  }

  // Axum: router.route("/path", get(handler))
  if (node.type === "call_expression" || node.type === "method_call_expression") {
    const raw = getNodeText(node, source);
    const axumMatch = raw.match(AXUM_ROUTE_RE);
    if (axumMatch) {
      const routePath = axumMatch[1];
      const verbChain = axumMatch[2];
      // Collect all verbs from the handler chain e.g. get(h).post(h2)
      const verbs = [...verbChain.matchAll(/(get|post|put|patch|delete)\s*\(/gi)].map(v => v[1].toUpperCase() as HttpMethod);
      for (const method of (verbs.length ? verbs : ["GET" as HttpMethod])) {
        if (isHttpMethod(method)) {
          endpoints.push({
            method,
            path: routePath,
            handler_module: moduleDotted,
            handler_qualname: "",
            description: "",
            payload_example: null,
            headers_hint: [],
            suggested_tool_name: suggestToolName(method, routePath, ""),
            file_path: relPath,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
          });
        }
      }
      return;
    }

    // Poem: Route::new().at("/path", get(handler))
    const poemMatch = raw.match(POEM_AT_RE);
    if (poemMatch) {
      const method = poemMatch[2].toUpperCase() as HttpMethod;
      if (isHttpMethod(method)) {
        endpoints.push({
          method,
          path: poemMatch[1],
          handler_module: moduleDotted,
          handler_qualname: "",
          description: "",
          payload_example: null,
          headers_hint: [],
          suggested_tool_name: suggestToolName(method, poemMatch[1], ""),
          file_path: relPath,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
        });
      }
      return;
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkNode(node.child(i)!, source, relPath, moduleDotted, endpoints, functions);
  }
}

export interface RustParseOutput {
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
  frameworkHits: string[];
  parseOk: boolean;
}

export function pathRustToModule(relPath: string): string {
  const noExt = relPath.replace(/\\/g, "/").replace(/\.rs$/, "");
  return noExt.split("/").filter(Boolean).join("::");
}

export function parseRustFile(input: { source: string; relPath: string; module: string }): RustParseOutput {
  const parser = getParser();
  const endpoints: HttpEndpoint[] = [];
  const functions: SurfaceFunction[] = [];
  const frameworkHits: string[] = [];

  let tree: any;
  try {
    tree = parser.parse(input.source);
  } catch {
    return { endpoints, functions, frameworkHits, parseOk: false };
  }

  for (const fw of FRAMEWORK_SIGNATURES) {
    if (fw.hints.some((h) => input.source.includes(h))) frameworkHits.push(fw.name);
  }

  walkNode(tree.rootNode, input.source, input.relPath, input.module, endpoints, functions);
  return { endpoints, functions, frameworkHits, parseOk: true };
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build", "target", "bin", "obj",
]);

export function extractRustSurface(opts: { workingDir: string }): SurfaceManifest {
  const workingDir = path.resolve(opts.workingDir);
  const endpoints: HttpEndpoint[] = [];
  const functions: SurfaceFunction[] = [];
  const frameworkCounts = new Map<string, number>();

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        const full = path.join(dir, entry.name);
        const relPath = path.relative(workingDir, full);
        let source: string;
        try { source = fs.readFileSync(full, "utf-8"); } catch { continue; }
        const result = parseRustFile({ source, relPath, module: pathRustToModule(relPath) });
        endpoints.push(...result.endpoints);
        functions.push(...result.functions);
        for (const f of result.frameworkHits) frameworkCounts.set(f, (frameworkCounts.get(f) ?? 0) + 1);
      }
    }
  }
  walk(workingDir);

  let framework: string | null = null;
  let maxCount = 0;
  for (const [fw, count] of frameworkCounts) {
    if (count > maxCount) { maxCount = count; framework = fw; }
  }

  return {
    language: "rust",
    framework,
    endpoints,
    functions,
    package_import_root: path.basename(workingDir),
  };
}
