// src/extractors/languages/python-parse.ts
//
// Pure tree-sitter parse for a single Python file.
//
// This module is designed to be import-safe from either the CLI main thread
// (fallback path) or a worker_threads child (fast path). It has no I/O
// beyond the tree-sitter native binding — the caller supplies the source
// bytes and the walker fills out endpoints + functions.

import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import type {
  HttpEndpoint,
  HttpMethod,
  SurfaceFunction,
} from "../core/surface-manifest.js";
import { isHttpMethod } from "../core/surface-manifest.js";
import {
  extractDecoratorName,
  getChildByFieldName,
  getNodeText,
} from "../../parsers/python/ast-utils.js";

const require = createRequire(import.meta.url);

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
// Decorator → route
// -----------------------------------------------------------------------------

const HTTP_VERB_DECORATORS: Record<string, HttpMethod> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE",
};

interface DecoratorHit { simple_name: string; raw: string }
interface RouteInfo { method: HttpMethod; path: string }

function decoratorToRoute(dec: DecoratorHit): RouteInfo | null {
  const simple = dec.simple_name.toLowerCase();
  const pathMatch = dec.raw.match(/\(\s*["']([^"']+)["']/);
  const routePath = pathMatch ? pathMatch[1] : null;
  if (simple in HTTP_VERB_DECORATORS && routePath) {
    return { method: HTTP_VERB_DECORATORS[simple], path: routePath };
  }
  if (simple === "route" && routePath) {
    const methodsMatch = dec.raw.match(/methods\s*=\s*\[\s*["'](\w+)["']/i);
    const method = (methodsMatch ? methodsMatch[1].toUpperCase() : "GET") as HttpMethod;
    return { method: isHttpMethod(method) ? method : "GET", path: routePath };
  }
  if (simple === "api_route" && routePath) {
    const m = dec.raw.match(/methods\s*=\s*\[\s*["'](\w+)["']/i);
    const method = (m ? m[1].toUpperCase() : "GET") as HttpMethod;
    return { method: isHttpMethod(method) ? method : "GET", path: routePath };
  }
  return null;
}

// -----------------------------------------------------------------------------
// AST helpers
// -----------------------------------------------------------------------------

function extractDocstring(funcNode: TreeSitter.SyntaxNode, bytes: Buffer): string {
  const body = getChildByFieldName(funcNode, "body");
  if (!body || body.childCount === 0) return "";
  const first = body.child(0);
  if (!first || first.type !== "expression_statement") return "";
  const str = first.child(0);
  if (!str || str.type !== "string") return "";
  let raw = getNodeText(str, bytes);
  const strip = (q: string, n: number) =>
    (raw.startsWith(q) && raw.endsWith(q) ? raw.slice(n, -n) : raw);
  raw = strip('"""', 3);
  raw = strip("'''", 3);
  raw = strip('"', 1);
  raw = strip("'", 1);
  return raw.trim().slice(0, 500);
}

function firstLine(node: TreeSitter.SyntaxNode, bytes: Buffer): string {
  return getNodeText(node, bytes).split("\n", 1)[0].trim();
}

function suggestToolName(method: HttpMethod, routePath: string, handlerName: string): string {
  const generic = new Set(["handler", "handle", "index", "root", "endpoint", "view", "func"]);
  if (!generic.has(handlerName.toLowerCase())) return handlerName.slice(0, 60);
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

function isInsideClass(node: TreeSitter.SyntaxNode): boolean {
  let cur: TreeSitter.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "class_definition") return true;
    cur = cur.parent;
  }
  return false;
}

function walkFunctionDefs(
  node: TreeSitter.SyntaxNode,
  bytes: Buffer,
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
          simple_name: extractDecoratorName(child, bytes),
          raw: getNodeText(child, bytes),
        });
      } else if (child.type === "function_definition") {
        funcNode = child;
        handledInnerFunc = child;
      }
    }
  } else if (node.type === "function_definition") {
    funcNode = node;
  }

  if (funcNode) {
    const nameNode = getChildByFieldName(funcNode, "name");
    if (nameNode) {
      const name = getNodeText(nameNode, bytes);
      const isPrivate = name.startsWith("_");
      const funcText = getNodeText(funcNode, bytes);
      const isAsync = funcText.trimStart().startsWith("async ");
      const docstring = extractDocstring(funcNode, bytes);
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
          payload_example: null,
          headers_hint: [],
          suggested_tool_name: suggestToolName(route.method, route.path, name),
        });
      }
      if (!isPrivate && !route && !isInsideClass(funcNode)) {
        functions.push({
          module: moduleDotted,
          qualname: name,
          signature: firstLine(funcNode, bytes),
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
    if (child === handledInnerFunc) continue;
    walkFunctionDefs(child, bytes, relPath, moduleDotted, endpoints, functions);
  }
}

// -----------------------------------------------------------------------------
// Framework fingerprints (string-only, cheap, reused across main and worker).
// -----------------------------------------------------------------------------

export const FRAMEWORK_SIGNATURES: ReadonlyArray<{ name: string; hints: readonly string[] }> = [
  { name: "fastapi",   hints: ["fastapi", "from fastapi"] },
  { name: "flask",     hints: ["from flask", "import flask"] },
  { name: "django",    hints: ["from django", "django.urls"] },
  { name: "starlette", hints: ["from starlette", "starlette."] },
  { name: "typer",     hints: ["import typer", "typer.Typer"] },
  { name: "click",     hints: ["import click", "@click.command"] },
];

// -----------------------------------------------------------------------------
// Public: parse ONE file → surface pieces + framework hits.
// -----------------------------------------------------------------------------

export interface PythonParseInput {
  source: string;
  relPath: string;
  module: string;
}

export interface PythonParseOutput {
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
  frameworkHits: string[]; // list of framework names whose hints matched
  parseOk: boolean;
}

export function pathToModule(relPath: string): string {
  const noExt = relPath.replace(/\\/g, "/").replace(/\.py$/, "");
  const parts = noExt.split("/").filter((p) => p && p !== "__init__");
  return parts.join(".");
}

export function parsePythonFile(input: PythonParseInput): PythonParseOutput {
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

  const bytes = Buffer.from(input.source, "utf-8");
  walkFunctionDefs(tree.rootNode, bytes, input.relPath, input.module, endpoints, functions);
  return { endpoints, functions, frameworkHits, parseOk: true };
}
