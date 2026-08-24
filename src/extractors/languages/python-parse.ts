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

function extractDocstring(funcNode: TreeSitter.SyntaxNode, source: string): string {
  const body = getChildByFieldName(funcNode, "body");
  if (!body || body.childCount === 0) return "";
  const first = body.child(0);
  if (!first || first.type !== "expression_statement") return "";
  const str = first.child(0);
  if (!str || str.type !== "string") return "";
  let raw = getNodeText(str, source);
  const strip = (q: string, n: number) =>
    (raw.startsWith(q) && raw.endsWith(q) ? raw.slice(n, -n) : raw);
  raw = strip('"""', 3);
  raw = strip("'''", 3);
  raw = strip('"', 1);
  raw = strip("'", 1);
  return raw.trim().slice(0, 500);
}

function firstLine(node: TreeSitter.SyntaxNode, source: string): string {
  return getNodeText(node, source).split("\n", 1)[0].trim();
}

// -----------------------------------------------------------------------------
// FastAPI / Flask body parameter extraction
//
// FastAPI route handlers declare request body as a Pydantic BaseModel parameter:
//   async def create_patient(body: PatientCreate): ...
// The extractor finds the route but sets payload_example: null because it doesn't
// inspect function parameters. This function:
//   1. Extracts function parameter names + type annotations from the signature
//   2. Identifies which params are body models (not path params, not Request/Response)
//   3. Looks up the Pydantic model class in the same source and extracts fields
//   4. Returns a payload_example dict with field → example-value entries
// -----------------------------------------------------------------------------

/** Primitive / framework types that are NOT body model params. */
const NON_BODY_TYPES = new Set([
  "Request", "Response", "BackgroundTasks", "Depends", "Header", "Query",
  "Path", "Cookie", "Form", "File", "UploadFile", "HTTPException",
  "str", "int", "float", "bool", "None", "Optional", "List", "Dict",
  "Any", "datetime", "date", "UUID",
]);

/** Extract {field: exampleValue} from a Pydantic BaseModel class in the source. */
function extractModelFields(modelName: string, source: string): Record<string, unknown> | null {
  // Find: class ModelName(BaseModel):
  const classRe = new RegExp(`class\\s+${modelName}\\s*\\([^)]*\\)\\s*:([\\s\\S]*?)(?=\\nclass\\s|\\nasync def\\s|\\ndef\\s|$)`);
  const classMatch = source.match(classRe);
  if (!classMatch) return null;

  const body = classMatch[1];
  const fields: Record<string, unknown> = {};

  // Match field declarations: field_name: type (= default)?
  const fieldRe = /^\s{4}(\w+)\s*:\s*([\w\[\]|, ]+?)(?:\s*=\s*(.+?))?$/gm;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const fieldName = m[1];
    const fieldType = m[2].trim();
    const defaultVal = m[3]?.trim();
    if (fieldName.startsWith("_")) continue;

    // Skip ClassVar, model_config etc.
    if (fieldType.includes("ClassVar") || fieldName === "model_config") continue;

    // Provide a type-appropriate example value
    if (defaultVal && defaultVal !== "..." && !defaultVal.startsWith("Field(")) {
      // Use the actual default if it's a literal
      if (defaultVal === "None") {
        fields[fieldName] = null;
      } else if (defaultVal.match(/^["']/)) {
        fields[fieldName] = defaultVal.slice(1, -1);
      } else if (defaultVal.match(/^\d+\.?\d*$/)) {
        fields[fieldName] = Number(defaultVal);
      } else if (defaultVal === "True") {
        fields[fieldName] = true;
      } else if (defaultVal === "False") {
        fields[fieldName] = false;
      } else {
        fields[fieldName] = fieldType.includes("int") ? 0 : "";
      }
    } else {
      // Generate example from type
      if (fieldType.includes("int")) fields[fieldName] = 0;
      else if (fieldType.includes("float")) fields[fieldName] = 0.0;
      else if (fieldType.includes("bool")) fields[fieldName] = false;
      else if (fieldType.includes("list") || fieldType.includes("List")) fields[fieldName] = [];
      else if (fieldType.includes("dict") || fieldType.includes("Dict")) fields[fieldName] = {};
      else fields[fieldName] = "";
    }
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * For a FastAPI route handler, extract the request body payload example.
 * Parses the function parameter list, finds Pydantic model params,
 * and recursively extracts their fields from the source.
 */
function extractPayloadExample(
  funcNode: TreeSitter.SyntaxNode,
  source: string,
  routePath: string,
  method: HttpMethod,
): Record<string, unknown> | null {
  // Only POST, PUT, PATCH typically have a body
  if (method === "GET" || method === "DELETE") return null;

  const funcText = getNodeText(funcNode, source);
  // Extract the params section: everything between first ( and )
  const sigMatch = funcText.match(/(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/s);
  if (!sigMatch) return null;

  const sigText = sigMatch[1];
  // Extract path param names from the route path to exclude them
  const pathParams = new Set([...routePath.matchAll(/\{(\w+)\}/g)].map(m => m[1]));

  // Parse each param: name: Type or name: Type = default
  const paramRe = /(\w+)\s*:\s*([^\s,=]+)/g;
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(sigText)) !== null) {
    const paramName = pm[1];
    const paramType = pm[2].replace(/Optional\[([^\]]+)\]/, "$1").trim();

    // Skip self, path params, and known non-body types
    if (paramName === "self" || pathParams.has(paramName)) continue;
    if (NON_BODY_TYPES.has(paramType)) continue;
    if (paramType.startsWith("Annotated")) continue;

    // This looks like a Pydantic model — try to extract its fields
    const fields = extractModelFields(paramType, source);
    if (fields) return fields;
  }

  return null;
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
        handledInnerFunc = child;
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
          payload_example: extractPayloadExample(funcNode, source, route.path, route.method),
          headers_hint: [],
          suggested_tool_name: suggestToolName(route.method, route.path, name),
          file_path: relPath,
          start_line: funcNode.startPosition.row + 1,
          end_line: funcNode.endPosition.row + 1,
        });
      }
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
    if (child === handledInnerFunc) continue;
    walkFunctionDefs(child, source, relPath, moduleDotted, endpoints, functions);
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

  walkFunctionDefs(tree.rootNode, input.source, input.relPath, input.module, endpoints, functions);
  return { endpoints, functions, frameworkHits, parseOk: true };
}
