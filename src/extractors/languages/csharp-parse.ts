// src/extractors/languages/csharp-parse.ts
//
// Pure tree-sitter parse for a single C# file.

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
  const CSharp = require("tree-sitter-c-sharp");
  const p = new TS();
  p.setLanguage(CSharp);
  _parser = p;
  return p;
}

export const FRAMEWORK_SIGNATURES = [
  { name: "aspnet", hints: ["Microsoft.AspNetCore", "[ApiController]", "ControllerBase"] },
  { name: "minimalapi", hints: ["WebApplication", "app.MapGet", "app.MapPost"] },
  { name: "mvc", hints: ["Controller", "ActionResult", "IActionResult"] },
];

const HTTP_ATTR_MAP: Record<string, HttpMethod> = {
  HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpPatch: "PATCH", HttpDelete: "DELETE",
};

function suggestToolName(method: HttpMethod, routePath: string, handlerName: string): string {
  const generic = new Set(["handler", "handle", "index", "root", "endpoint"]);
  if (handlerName && !generic.has(handlerName.toLowerCase())) return handlerName.slice(0, 60);
  const cleaned = routePath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\{[^}]+\}/g, "by_param")
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
  // Controller class methods
  if (node.type === "class_declaration") {
    const classRaw = getNodeText(node, source);
    const isController = classRaw.includes("[ApiController]") ||
      classRaw.includes("ControllerBase") || classRaw.includes(": Controller");

    if (isController) {
      // Extract class-level [Route("prefix")] — e.g. [Route("api/[controller]")]
      // [controller] token resolves to the class name minus "Controller" suffix.
      const classNameMatch = classRaw.match(/\bclass\s+(\w+)Controller\b/);
      const controllerSegment = classNameMatch ? classNameMatch[1].toLowerCase() : "";
      const classRouteMatch = classRaw.match(/\[Route\s*\(\s*"([^"]+)"/);
      let classPrefix = classRouteMatch
        ? classRouteMatch[1].replace(/\[controller\]/gi, controllerSegment)
        : "";
      classPrefix = classPrefix.replace(/^\/+|\/+$/g, "");

      // Walk method declarations
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === "declaration_list") {
          for (let j = 0; j < child.childCount; j++) {
            const member = child.child(j)!;
            if (member.type === "method_declaration") {
              walkControllerMethod(member, source, relPath, moduleDotted, endpoints, functions, classPrefix);
            }
          }
        }
      }
      return;
    }
  }

  // Minimal API: app.MapGet("/path", handler)
  if (node.type === "invocation_expression") {
    const raw = getNodeText(node, source);
    const mapMatch = raw.match(/\.(Map(?:Get|Post|Put|Patch|Delete))\s*\(\s*"([^"]+)"/i);
    if (mapMatch) {
      const methodName = mapMatch[1].replace("Map", "").toUpperCase() as HttpMethod;
      const routePath = mapMatch[2];
      if (isHttpMethod(methodName)) {
        endpoints.push({
          method: methodName,
          path: routePath,
          handler_module: moduleDotted,
          handler_qualname: "",
          description: "",
          payload_example: null,
          headers_hint: [],
          suggested_tool_name: suggestToolName(methodName, routePath, ""),
          file_path: relPath,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
        });
        return;
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkNode(node.child(i)!, source, relPath, moduleDotted, endpoints, functions);
  }
}

function walkControllerMethod(
  node: TreeSitter.SyntaxNode,
  source: string,
  relPath: string,
  moduleDotted: string,
  endpoints: HttpEndpoint[],
  functions: SurfaceFunction[],
  classPrefix = "",
): void {
  const raw = getNodeText(node, source);

  for (const [attr, method] of Object.entries(HTTP_ATTR_MAP)) {
    if (raw.includes(`[${attr}`)) {
      const pathMatch = raw.match(new RegExp(`\\[${attr}\\s*(?:\\(\\s*"([^"]*)")?`));
      const methodPath = (pathMatch?.[1] ?? "").replace(/^\/+|\/+$/g, "");
      // Combine class prefix + method path
      const parts = [classPrefix, methodPath].filter(Boolean);
      const routePath = parts.length ? "/" + parts.join("/") : "";
      // Extract method name from the first line of the declaration (before the body)
      const firstLine = raw.split(/[\r\n{=>]/)[0];
      const nameMatch = firstLine.match(/(?:public|protected|private)(?:\s+\w+)+\s+(\w+)\s*\(/);
      const handlerName = nameMatch ? nameMatch[1] : "";
      endpoints.push({
        method,
        path: routePath,
        handler_module: moduleDotted,
        handler_qualname: handlerName,
        description: "",
        payload_example: null,
        headers_hint: [],
        suggested_tool_name: suggestToolName(method, routePath, handlerName),
        file_path: relPath,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      });
      return;
    }
  }

  // Public method without HTTP attribute — capture as function
  if (raw.includes("public ")) {
    const nameMatch = raw.match(/public\s+(?:\S+\s+)+(\w+)\s*\(/);
    if (nameMatch) {
      functions.push({
        module: moduleDotted,
        qualname: nameMatch[1],
        signature: raw.split("\n")[0].trim().slice(0, 200),
        docstring: "",
        is_async: raw.includes("async "),
        is_public: true,
        file_path: relPath,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
      });
    }
  }
}

export interface CsharpParseOutput {
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
  frameworkHits: string[];
  parseOk: boolean;
}

export function pathCsharpToModule(relPath: string): string {
  const noExt = relPath.replace(/\\/g, "/").replace(/\.cs$/, "");
  return noExt.split("/").filter(Boolean).join(".");
}

export function parseCsharpFile(input: { source: string; relPath: string; module: string }): CsharpParseOutput {
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

export function extractCsharpSurface(opts: { workingDir: string }): SurfaceManifest {
  const workingDir = path.resolve(opts.workingDir);
  const endpoints: HttpEndpoint[] = [];
  const functions: SurfaceFunction[] = [];
  const frameworkCounts = new Map<string, number>();

  const csFiles: { full: string; relPath: string }[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".cs")) {
        csFiles.push({ full: path.join(dir, entry.name), relPath: path.relative(workingDir, path.join(dir, entry.name)) });
      }
    }
  }
  walk(workingDir);

  for (const { full, relPath } of csFiles) {
    let source: string;
    try { source = fs.readFileSync(full, "utf-8"); } catch { continue; }
    const result = parseCsharpFile({ source, relPath, module: pathCsharpToModule(relPath) });
    endpoints.push(...result.endpoints);
    functions.push(...result.functions);
    for (const f of result.frameworkHits) frameworkCounts.set(f, (frameworkCounts.get(f) ?? 0) + 1);
  }

  let framework: string | null = null;
  let maxCount = 0;
  for (const [fw, count] of frameworkCounts) {
    if (count > maxCount) { maxCount = count; framework = fw; }
  }

  return {
    language: "csharp",
    framework,
    endpoints,
    functions,
    package_import_root: path.basename(workingDir),
  };
}
