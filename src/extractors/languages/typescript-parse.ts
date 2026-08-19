// src/extractors/languages/typescript-parse.ts
//
// Pure tree-sitter parse for a single TypeScript/TSX file.

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
  const TSLang = require("tree-sitter-typescript").typescript;
  const p = new TS();
  p.setLanguage(TSLang);
  _parser = p;
  return p;
}

export const FRAMEWORK_SIGNATURES = [
  { name: "express",  hints: ["from 'express'", 'from "express"', "require('express')", 'require("express")'] },
  { name: "fastify",  hints: ["from 'fastify'", 'from "fastify"', "fastify()", "Fastify()"] },
  { name: "nestjs",   hints: ["@nestjs/", "@Controller", "@Get(", "@Post("] },
  { name: "koa",      hints: ["from 'koa'", "from '@koa/router'", "koa-router", 'require("koa")'] },
  { name: "hapi",     hints: ["@hapi/hapi", "from 'hapi'", 'from "@hapi/hapi"'] },
  { name: "hono",     hints: ["from 'hono'", 'from "hono"', "new Hono("] },
  { name: "next",     hints: ["NextApiRequest", "NextApiResponse", "next/server", "app/api"] },
  { name: "loopback", hints: ["@loopback/rest", "@loopback/core"] },
  { name: "restify",  hints: ["from 'restify'", 'require("restify")'] },
  { name: "sails",    hints: ["sails.config.routes"] },
];

const HTTP_METHOD_MAP: Record<string, HttpMethod> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE",
  del: "DELETE",
};

// Noir's comprehensive verb-method regex — covers Express, Fastify, Koa, Hono and any
// receiver name (app, router, r, api, v1, etc.) matching Noir's combined fallback pattern.
const VERB_CALL_RE = /\.(get|post|put|patch|delete|del|head|options|all|query)\s*\(\s*["'`]([^"'`]+)["'`]/i;

// Fastify route({method, url}) config-object pattern.
const FASTIFY_ROUTE_RE = /\.(route|addRoute)\s*\(\s*\{[^}]*(?:method|methods)\s*:/i;
const FASTIFY_METHOD_RE = /\bmethods?\s*:\s*["'](\w+)["']/i;
const FASTIFY_URL_RE = /\b(?:url|path)\s*:\s*["']([^"']+)["']/i;

// app.route('/path').get(...).post(...) method chaining
const ROUTE_CHAIN_RE = /\.route\s*\(\s*["'`]([^"'`]+)["'`]/;

function suggestToolName(method: HttpMethod, routePath: string, handlerName: string): string {
  const generic = new Set(["handler", "handle", "index", "root", "endpoint", "view", "func", "default"]);
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
  controllerPrefix: string,
): void {
  // NestJS: class with @Controller decorator
  if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
    let classControllerPath = controllerPrefix;
    // Look for decorators before the class
    const parent = node.parent;
    if (parent) {
      for (let i = 0; i < parent.childCount; i++) {
        const sib = parent.child(i)!;
        if (sib === node) break;
        if (sib.type === "decorator") {
          const raw = getNodeText(sib, source);
          const m = raw.match(/@Controller\s*\(\s*["'`]([^"'`]*)["'`]/);
          if (m) classControllerPath = m[1];
        }
      }
    }
    // Walk children looking for method defs
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "class_body") {
        for (let j = 0; j < child.childCount; j++) {
          const member = child.child(j)!;
          walkMethodMember(member, source, relPath, moduleDotted, endpoints, functions, classControllerPath);
        }
      }
    }
    return;
  }

  // Express/Fastify/Koa/Hono call-style: app.get("/path", handler)
  // Uses Noir's comprehensive verb-method regex with any receiver name.
  if (node.type === "call_expression" || node.type === "await_expression") {
    const raw = getNodeText(node, source);

    // Standard verb method: .get("/path"), .post("/path"), etc.
    const routeMatch = raw.match(VERB_CALL_RE);
    if (routeMatch) {
      const verbLower = routeMatch[1].toLowerCase();
      const method = (HTTP_METHOD_MAP[verbLower] ?? verbLower.toUpperCase()) as HttpMethod;
      const routePath = routeMatch[2];
      if (isHttpMethod(method) || method === "ALL") {
        endpoints.push({
          method: isHttpMethod(method) ? method : "GET",
          path: routePath,
          handler_module: moduleDotted,
          handler_qualname: "",
          description: "",
          payload_example: null,
          headers_hint: [],
          suggested_tool_name: suggestToolName(isHttpMethod(method) ? method : "GET", routePath, ""),
          file_path: relPath,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
        });
      }
    }

    // Fastify route({method, url}) config object
    if (FASTIFY_ROUTE_RE.test(raw)) {
      const methodM = raw.match(FASTIFY_METHOD_RE);
      const urlM = raw.match(FASTIFY_URL_RE);
      if (methodM && urlM) {
        const method = methodM[1].toUpperCase() as HttpMethod;
        if (isHttpMethod(method)) {
          endpoints.push({
            method,
            path: urlM[1],
            handler_module: moduleDotted,
            handler_qualname: "",
            description: "",
            payload_example: null,
            headers_hint: [],
            suggested_tool_name: suggestToolName(method, urlM[1], ""),
            file_path: relPath,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
          });
        }
      }
    }

    // Method chaining: app.route('/path').get().post()
    // Only run this pass when the node actually contains .route('...') — skip
    // simple verb calls already caught above to avoid duplicates.
    const chainMatch = !routeMatch && raw.match(ROUTE_CHAIN_RE);
    if (chainMatch) {
      const chainPath = chainMatch[1];
      const verbs = [...raw.matchAll(/\.(get|post|put|patch|delete|del)\s*\(/gi)];
      for (const v of verbs) {
        const method = (HTTP_METHOD_MAP[v[1].toLowerCase()] ?? v[1].toUpperCase()) as HttpMethod;
        if (isHttpMethod(method)) {
          endpoints.push({
            method,
            path: chainPath,
            handler_module: moduleDotted,
            handler_qualname: "",
            description: "",
            payload_example: null,
            headers_hint: [],
            suggested_tool_name: suggestToolName(method, chainPath, ""),
            file_path: relPath,
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,
          });
        }
      }
    }
  }

  // Next.js exported handler functions
  if (node.type === "export_statement") {
    const raw = getNodeText(node, source);
    if (raw.includes("NextApiRequest") || raw.includes("NextRequest")) {
      const fnMatch = raw.match(/(?:async\s+)?function\s+(\w+)/);
      const name = fnMatch ? fnMatch[1] : "handler";
      functions.push({
        module: moduleDotted,
        qualname: name,
        signature: raw.split("\n")[0].trim().slice(0, 200),
        docstring: "",
        is_async: raw.includes("async"),
        is_public: true,
        file_path: relPath,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    // Don't recurse into classes (already handled above)
    if (child.type !== "class_declaration" && child.type !== "abstract_class_declaration") {
      walkNode(child, source, relPath, moduleDotted, endpoints, functions, controllerPrefix);
    } else {
      walkNode(child, source, relPath, moduleDotted, endpoints, functions, controllerPrefix);
    }
  }
}

function walkMethodMember(
  node: TreeSitter.SyntaxNode,
  source: string,
  relPath: string,
  moduleDotted: string,
  endpoints: HttpEndpoint[],
  functions: SurfaceFunction[],
  controllerPrefix: string,
): void {
  if (node.type !== "method_definition" && node.type !== "public_field_definition") return;

  const decorators: { name: string; raw: string }[] = [];
  const parent = node.parent;
  if (parent) {
    for (let i = 0; i < parent.childCount; i++) {
      const sib = parent.child(i)!;
      if (sib === node) break;
      if (sib.type === "decorator") {
        const raw = getNodeText(sib, source);
        const nameMatch = raw.match(/@(\w+)/);
        if (nameMatch) decorators.push({ name: nameMatch[1], raw });
      }
    }
  }

  for (const dec of decorators) {
    const methodName = dec.name.toUpperCase();
    if (methodName in HTTP_METHOD_MAP || ["GET","POST","PUT","PATCH","DELETE"].includes(methodName)) {
      const method = HTTP_METHOD_MAP[dec.name.toLowerCase()] ?? ("GET" as HttpMethod);
      const pathMatch = dec.raw.match(/@\w+\s*\(\s*["'`]([^"'`]*)["'`]/);
      const subPath = pathMatch ? pathMatch[1] : "";
      const fullPath = "/" + [controllerPrefix, subPath].filter(Boolean).join("/").replace(/\/+/g, "/");
      const nameNode = node.childForFieldName?.("name") ?? node.child(0);
      const handlerName = nameNode ? getNodeText(nameNode, source) : "handler";
      endpoints.push({
        method,
        path: fullPath,
        handler_module: moduleDotted,
        handler_qualname: handlerName,
        description: "",
        payload_example: null,
        headers_hint: [],
        suggested_tool_name: suggestToolName(method, fullPath, handlerName),
        file_path: relPath,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      });
    }
  }
}

export interface TypescriptParseOutput {
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
  frameworkHits: string[];
  parseOk: boolean;
}

export function pathTypescriptToModule(relPath: string): string {
  const noExt = relPath.replace(/\\/g, "/").replace(/\.(ts|tsx)$/, "");
  return noExt.split("/").filter(Boolean).join(".");
}

export function parseTypescriptFile(input: { source: string; relPath: string; module: string }): TypescriptParseOutput {
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

  walkNode(tree.rootNode, input.source, input.relPath, input.module, endpoints, functions, "");

  // Deduplicate by (method, path) preserving first occurrence — avoids double-counting
  // from method-chain nodes being visited at multiple AST depths.
  const seen = new Set<string>();
  const deduped = endpoints.filter((ep) => {
    const key = `${ep.method}:${ep.path}:${ep.start_line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { endpoints: deduped, functions, frameworkHits, parseOk: true };
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build", "target", "bin", "obj", ".next", "out",
]);

export function extractTypescriptSurface(opts: { workingDir: string }): SurfaceManifest {
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
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        const full = path.join(dir, entry.name);
        const relPath = path.relative(workingDir, full);
        let source: string;
        try { source = fs.readFileSync(full, "utf-8"); } catch { continue; }
        const result = parseTypescriptFile({ source, relPath, module: pathTypescriptToModule(relPath) });
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
    language: "typescript",
    framework,
    endpoints,
    functions,
    package_import_root: path.basename(workingDir),
  };
}
