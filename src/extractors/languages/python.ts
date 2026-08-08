// src/extractors/languages/python.ts
//
// Python language extractor for the SurfaceManifest.
//
// Built on the existing tree-sitter Python parser in src/parsers/python.
// Adds decorator-body parsing to lift HTTP method + route path out of common
// framework decorators (FastAPI, Flask, Starlette-style, Django path()).
//
// Runs deterministically — same repo → same manifest.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import type {
  HttpEndpoint,
  HttpMethod,
  SurfaceFunction,
  SurfaceManifest,
} from "../core/surface-manifest.js";
import { isHttpMethod } from "../core/surface-manifest.js";
import {
  extractDecoratorName,
  getChildByFieldName,
  getNodeText,
} from "../../parsers/python/ast-utils.js";

const require = createRequire(import.meta.url);

// -----------------------------------------------------------------------------
// Tree-sitter parser singleton
// -----------------------------------------------------------------------------

let _parser: TreeSitter | null = null;
function getParser(): TreeSitter {
  if (_parser) return _parser;
  const TS = require("tree-sitter");
  const Python = require("tree-sitter-python");
  const p = new TS();
  p.setLanguage(Python);
  _parser = p;
  return p;
}

// -----------------------------------------------------------------------------
// Directory / file skip lists (mirror function-extractor.ts tier 1-2 rules)
// -----------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "__pycache__", ".git", ".venv", "venv", "node_modules", ".synapse",
  "env", ".env", "tests", "test", "testing", "dist", "build",
  ".egg-info", ".pytest_cache", ".mypy_cache", ".tox", "mcp",
]);

const SKIP_FILENAMES = new Set([
  "mcp_server.py", "setup.py", "conftest.py", "noxfile.py",
]);

const SKIP_FILE_PARTIALS = ["test_", "_test.py", "tests.py"];

// -----------------------------------------------------------------------------
// Shared marker needle tables for the Aho-Corasick prefilter.
//
// Keep in lockstep with `decoratorToRoute()` below — any HTTP verb decorator
// this list can match must have a routing rule in `decoratorToRoute`, and
// vice versa. The prefilter uses these to reject 99% of files in a 500k LOC
// repo before tree-sitter ever runs.
// -----------------------------------------------------------------------------

// Needle tables are language-keyed in core/needles.ts. Re-exported here as
// stable named constants for anywhere that imported them from python.ts
// before the refactor.
import { NEEDLE_TABLE } from "../core/needles.js";
export const PY_ROUTE_NEEDLES: readonly string[] = NEEDLE_TABLE.python.route;
export const PY_FUNCTION_NEEDLES: readonly string[] = NEEDLE_TABLE.python.callable;

// -----------------------------------------------------------------------------
// Framework decorator recognition
// -----------------------------------------------------------------------------

/** FastAPI/Starlette-style HTTP verbs written as @app.get(...) / @router.post(...) etc. */
const HTTP_VERB_DECORATORS: Record<string, HttpMethod> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};

interface DecoratorHit {
  /** Simple decorator name after the last dot, e.g. "get" from "@router.get(...)". */
  simple_name: string;
  /** Raw source of the decorator (used for route arg parsing). */
  raw: string;
}

interface RouteInfo {
  method: HttpMethod;
  path: string;
}

/**
 * Given a decorator source line like `@app.get("/orders/{id}", tags=["orders"])`
 * or `@app.route("/api/foo", methods=["POST"])` — return the HTTP method and path,
 * or null if it isn't recognizable as a route decorator.
 */
function decoratorToRoute(dec: DecoratorHit): RouteInfo | null {
  const simple = dec.simple_name.toLowerCase();

  // The first positional string argument is always the path in every framework
  // we care about — extract it with a single regex over the raw decorator.
  const pathMatch = dec.raw.match(/\(\s*["']([^"']+)["']/);
  const routePath = pathMatch ? pathMatch[1] : null;

  // FastAPI / Starlette / APIRouter: @app.get, @router.post, ...
  if (simple in HTTP_VERB_DECORATORS && routePath) {
    return { method: HTTP_VERB_DECORATORS[simple], path: routePath };
  }

  // Flask / Bottle: @app.route("/x", methods=["POST"])
  if (simple === "route" && routePath) {
    const methodsMatch = dec.raw.match(/methods\s*=\s*\[\s*["'](\w+)["']/i);
    const method = (methodsMatch ? methodsMatch[1].toUpperCase() : "GET") as HttpMethod;
    return { method: isHttpMethod(method) ? method : "GET", path: routePath };
  }

  // FastAPI generic: @app.api_route("/x", methods=["POST"])
  if (simple === "api_route" && routePath) {
    const m = dec.raw.match(/methods\s*=\s*\[\s*["'](\w+)["']/i);
    const method = (m ? m[1].toUpperCase() : "GET") as HttpMethod;
    return { method: isHttpMethod(method) ? method : "GET", path: routePath };
  }

  return null;
}

// -----------------------------------------------------------------------------
// Function-scope helpers (small, tree-sitter-only)
// -----------------------------------------------------------------------------

function extractDocstring(
  funcNode: TreeSitter.SyntaxNode,
  source: string,
): string {
  const body = getChildByFieldName(funcNode, "body");
  if (!body || body.childCount === 0) return "";
  const first = body.child(0);
  if (!first || first.type !== "expression_statement") return "";
  const str = first.child(0);
  if (!str || str.type !== "string") return "";
  let raw = getNodeText(str, source);
  const strip = (q: string, n: number) =>
    raw.startsWith(q) && raw.endsWith(q) ? raw.slice(n, -n) : raw;
  raw = strip('"""', 3);
  raw = strip("'''", 3);
  raw = strip('"', 1);
  raw = strip("'", 1);
  return raw.trim().slice(0, 500);
}

/** First line of the function definition — used as the signature. */
function firstLine(node: TreeSitter.SyntaxNode, source: string): string {
  const text = getNodeText(node, source);
  return text.split("\n", 1)[0].trim();
}

/** Convert repo-relative path → dotted Python module: `app/routes/orders.py` → `app.routes.orders`. */
function pathToModule(relPath: string): string {
  const noExt = relPath.replace(/\\/g, "/").replace(/\.py$/, "");
  const parts = noExt.split("/").filter((p) => p && p !== "__init__");
  return parts.join(".");
}

/** Prefer the handler function name (it's what the developer already picked)
 *  and fall back to `${verb}_${sanitized_path}` only when the handler name
 *  is generic ("handler", "index", or matches only the verb). */
function suggestToolName(method: HttpMethod, routePath: string, handlerName: string): string {
  const generic = new Set(["handler", "handle", "index", "root", "endpoint", "view", "func"]);
  if (!generic.has(handlerName.toLowerCase())) {
    return handlerName.slice(0, 60);
  }
  const cleaned = routePath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase();
  const verb = method === "GET" ? "get" : method === "POST" ? "create" :
               method === "PUT" ? "update" : method === "PATCH" ? "patch" : "delete";
  const base = cleaned || handlerName;
  return `${verb}_${base}`.slice(0, 60);
}

// -----------------------------------------------------------------------------
// Framework detection (rough — top-N imports across the repo)
// -----------------------------------------------------------------------------

const FRAMEWORK_SIGNATURES: Array<{ name: string; hints: string[] }> = [
  { name: "fastapi",  hints: ["fastapi", "from fastapi"] },
  { name: "flask",    hints: ["from flask", "import flask"] },
  { name: "django",   hints: ["from django", "django.urls"] },
  { name: "starlette",hints: ["from starlette", "starlette."] },
  { name: "typer",    hints: ["import typer", "typer.Typer"] },
  { name: "click",    hints: ["import click", "@click.command"] },
];

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export interface PythonExtractorOptions {
  workingDir: string;
  /** Optional cap on files walked; defaults to 5000. */
  maxFiles?: number;
}

export function extractPythonSurface(opts: PythonExtractorOptions): SurfaceManifest {
  const workingDir = path.resolve(opts.workingDir);
  const maxFiles = opts.maxFiles ?? 5000;

  const files: string[] = [];
  walk(workingDir, workingDir, files, maxFiles);

  const endpoints: HttpEndpoint[] = [];
  const functions: SurfaceFunction[] = [];
  const frameworkHits = new Map<string, number>();

  const parser = getParser();

  for (const abs of files) {
    let source: string;
    try {
      source = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    let tree: any;
    try {
      tree = parser.parse(source);
    } catch {
      continue;
    }

    // Framework fingerprint scan (cheap, string-only)
    for (const fw of FRAMEWORK_SIGNATURES) {
      if (fw.hints.some((h) => source.includes(h))) {
        frameworkHits.set(fw.name, (frameworkHits.get(fw.name) ?? 0) + 1);
      }
    }

    const relPath = path.relative(workingDir, abs);
    const module = pathToModule(relPath);
    walkFunctionDefs(tree.rootNode, source, relPath, module, endpoints, functions);
  }

  const framework = topFramework(frameworkHits);
  const packageRoot = detectPackageRoot(functions, endpoints);

  return {
    language: "python",
    framework,
    endpoints,
    functions,
    package_import_root: packageRoot,
  };
}

// -----------------------------------------------------------------------------
// Directory walking
// -----------------------------------------------------------------------------

function walk(dir: string, root: string, out: string[], maxFiles: number): void {
  if (out.length >= maxFiles) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(full, root, out, maxFiles);
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      if (SKIP_FILENAMES.has(entry.name)) continue;
      if (SKIP_FILE_PARTIALS.some((p) => entry.name.includes(p))) continue;
      out.push(full);
    }
  }
}

// -----------------------------------------------------------------------------
// AST walker — populates endpoints[] and functions[]
// -----------------------------------------------------------------------------

function walkFunctionDefs(
  node: TreeSitter.SyntaxNode,
  source: string,
  relPath: string,
  moduleDotted: string,
  endpoints: HttpEndpoint[],
  functions: SurfaceFunction[],
): void {
  let funcNode: TreeSitter.SyntaxNode | null = null;
  let handledInnerFunc: TreeSitter.SyntaxNode | null = null;
  const decorators: DecoratorHit[] = [];

  if (node.type === "decorated_definition") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "decorator") {
        decorators.push({
          simple_name: extractDecoratorName(child, source),
          raw: getNodeText(child, source),
        });
      } else if (child.type === "function_definition") {
        funcNode = child;
        handledInnerFunc = child; // don't re-visit as a bare function_definition
      }
    }
  } else if (node.type === "function_definition") {
    funcNode = node;
  }

  if (funcNode) {
    const nameNode = getChildByFieldName(funcNode, "name");
    if (nameNode) {
      const name = getNodeText(nameNode, source);
      const isPrivate = name.startsWith("_");
      const funcText = getNodeText(funcNode, source);
      const isAsync = funcText.trimStart().startsWith("async ");
      const docstring = extractDocstring(funcNode, source);

      // Endpoint? Look for a route-shaped decorator.
      let route: RouteInfo | null = null;
      for (const dec of decorators) {
        route = decoratorToRoute(dec);
        if (route) break;
      }

      if (route && !isPrivate) {
        endpoints.push({
          method: route.method,
          path: route.path,
          handler_module: moduleDotted,
          handler_qualname: name,
          description: docstring,
          payload_example: null, // M1: best-effort; can be enriched later
          headers_hint: [], // M1: none inferred
          suggested_tool_name: suggestToolName(route.method, route.path, name),
          file_path: relPath,
          start_line: funcNode.startPosition.row + 1,
          end_line: funcNode.endPosition.row + 1,
        });
      }

      // Function candidate for Custom mode — public, non-test, non-endpoint,
      // and not inside a class (top-level only for M1).
      if (!isPrivate && !route && !isInsideClass(funcNode)) {
        functions.push({
          module: moduleDotted,
          qualname: name,
          signature: firstLine(funcNode, source),
          docstring,
          is_async: isAsync,
          is_public: true,
          file_path: relPath,
          start_line: funcNode.startPosition.row + 1,
          end_line: funcNode.endPosition.row + 1,
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child === handledInnerFunc) continue; // already processed via decorated_definition
    walkFunctionDefs(child, source, relPath, moduleDotted, endpoints, functions);
  }
}

function isInsideClass(node: TreeSitter.SyntaxNode): boolean {
  let cur: TreeSitter.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "class_definition") return true;
    cur = cur.parent;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Aggregators
// -----------------------------------------------------------------------------

function topFramework(hits: Map<string, number>): string | null {
  if (hits.size === 0) return null;
  let best: [string, number] | null = null;
  for (const entry of hits) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best ? best[0] : null;
}

/** Heuristic: the shortest common module prefix across endpoints+functions.
 *  Falls back to the first path segment. */
export function detectPackageRoot(
  functions: SurfaceFunction[],
  endpoints: HttpEndpoint[],
): string {
  const modules: string[] = [
    ...functions.map((f) => f.module),
    ...endpoints.map((e) => e.handler_module),
  ].filter(Boolean);
  if (modules.length === 0) return "";
  const firstParts = modules[0].split(".");
  let commonLen = firstParts.length;
  for (const m of modules) {
    const parts = m.split(".");
    let i = 0;
    while (i < commonLen && i < parts.length && parts[i] === firstParts[i]) i++;
    commonLen = i;
    if (commonLen === 0) break;
  }
  return firstParts.slice(0, Math.max(commonLen, 1)).join(".");
}
