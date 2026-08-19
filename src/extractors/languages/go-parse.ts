// src/extractors/languages/go-parse.ts
//
// Pure tree-sitter parse for a single Go file.

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
  const Go = require("tree-sitter-go");
  const p = new TS();
  p.setLanguage(Go);
  _parser = p;
  return p;
}

export const FRAMEWORK_SIGNATURES = [
  { name: "gin",        hints: ["github.com/gin-gonic/gin", "gin.Default()", "gin.New()"] },
  { name: "echo",       hints: ["github.com/labstack/echo", "echo.New()"] },
  { name: "chi",        hints: ["github.com/go-chi/chi"] },
  { name: "fiber",      hints: ["github.com/gofiber/fiber"] },
  { name: "gorilla",    hints: ["github.com/gorilla/mux"] },
  { name: "httprouter", hints: ["github.com/julienschmidt/httprouter"] },
  { name: "fasthttp",   hints: ["github.com/valyala/fasthttp"] },
  { name: "iris",       hints: ["github.com/kataras/iris"] },
  { name: "beego",      hints: ["github.com/beego/beego", "beego.Router"] },
  { name: "stdlib",     hints: ["net/http", "http.HandleFunc", "http.Handle"] },
];

// Noir Go patterns — covers all major Go router DSLs:
// Gin/Echo: .GET/.POST (uppercase), Chi/Fiber: .Get/.Post (CamelCase), net/http: HandleFunc
const VERB_UPPER_RE = /\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/;
const VERB_CAMEL_RE = /\.(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/;
// Generic Handle(method, path, handler) — used by Gin, echo.Add, etc.
const HANDLE_METHOD_RE = /\.(?:Handle|Add)\s*\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*"([^"]+)"/;
// net/http + gorilla: HandleFunc/Handle with path
const HANDLEFUNC_RE = /\.?HandleFunc\s*\(\s*"([^"]+)"/;
const HANDLE_RE = /(?:http|mux|r)\.Handle\s*\(\s*"([^"]+)"/;
// Gorilla .Methods("GET") chained after HandleFunc
const METHODS_CHAIN_RE = /\.Methods\s*\(\s*"([^"]+)"/;

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

function walkNode(
  node: TreeSitter.SyntaxNode,
  source: string,
  relPath: string,
  moduleDotted: string,
  endpoints: HttpEndpoint[],
  functions: SurfaceFunction[],
): void {
  if (node.type === "call_expression") {
    const raw = getNodeText(node, source);

    function pushEp(method: HttpMethod, routePath: string): void {
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

    // Gin/Echo uppercase: r.GET("/path", handler)
    const upperMatch = raw.match(VERB_UPPER_RE);
    if (upperMatch) { pushEp(upperMatch[1] as HttpMethod, upperMatch[2]); return; }

    // Chi/Fiber CamelCase: r.Get("/path", handler)
    const camelMatch = raw.match(VERB_CAMEL_RE);
    if (camelMatch) { pushEp(camelMatch[1].toUpperCase() as HttpMethod, camelMatch[2]); return; }

    // Generic Handle/Add(method, path) — Gin router.Handle, echo.Add
    const handleMethodMatch = raw.match(HANDLE_METHOD_RE);
    if (handleMethodMatch) { pushEp(handleMethodMatch[1] as HttpMethod, handleMethodMatch[2]); return; }

    // net/http HandleFunc: look for gorilla .Methods() chain for the real verb
    const handleFuncMatch = raw.match(HANDLEFUNC_RE);
    if (handleFuncMatch) {
      const methodsChain = raw.match(METHODS_CHAIN_RE);
      const method = (methodsChain ? methodsChain[1].toUpperCase() : "GET") as HttpMethod;
      pushEp(isHttpMethod(method) ? method : "GET", handleFuncMatch[1]);
      return;
    }

    // http.Handle / mux.Handle (all methods — default to GET, actual method is runtime)
    const handleMatch = raw.match(HANDLE_RE);
    if (handleMatch) { pushEp("GET", handleMatch[1]); return; }
  }

  // Capture exported functions
  if (node.type === "function_declaration") {
    const raw = getNodeText(node, source);
    const nameMatch = raw.match(/^func\s+([A-Z]\w*)/);
    if (nameMatch) {
      functions.push({
        module: moduleDotted,
        qualname: nameMatch[1],
        signature: raw.split("\n")[0].trim().slice(0, 200),
        docstring: "",
        is_async: false,
        is_public: true,
        file_path: relPath,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkNode(node.child(i)!, source, relPath, moduleDotted, endpoints, functions);
  }
}

export interface GoParseOutput {
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
  frameworkHits: string[];
  parseOk: boolean;
}

export function pathGoToModule(relPath: string): string {
  const dir = path.dirname(relPath).replace(/\\/g, "/");
  return dir === "." ? path.basename(relPath, ".go") : dir.split("/").pop() ?? "main";
}

export function parseGoFile(input: { source: string; relPath: string; module: string }): GoParseOutput {
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
  "node_modules", ".git", ".venv", "venv", "dist", "build", "target", "bin", "obj", "vendor",
]);

export function extractGoSurface(opts: { workingDir: string }): SurfaceManifest {
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
      } else if (entry.isFile() && entry.name.endsWith(".go")) {
        const full = path.join(dir, entry.name);
        const relPath = path.relative(workingDir, full);
        let source: string;
        try { source = fs.readFileSync(full, "utf-8"); } catch { continue; }
        const result = parseGoFile({ source, relPath, module: pathGoToModule(relPath) });
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
    language: "go",
    framework,
    endpoints,
    functions,
    package_import_root: path.basename(workingDir),
  };
}
