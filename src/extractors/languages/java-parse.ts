// src/extractors/languages/java-parse.ts
//
// Pure tree-sitter parse for a single Java file.

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
  const Java = require("tree-sitter-java");
  const p = new TS();
  p.setLanguage(Java);
  _parser = p;
  return p;
}

export const FRAMEWORK_SIGNATURES = [
  { name: "spring",    hints: ["@SpringBootApplication", "springframework", "@RestController", "@Controller", "@RequestMapping"] },
  { name: "jaxrs",     hints: ["javax.ws.rs", "jakarta.ws.rs", "@Path", "jax-rs"] },
  { name: "micronaut", hints: ["io.micronaut", "@Controller", "micronaut.http"] },
  { name: "quarkus",   hints: ["io.quarkus", "quarkus.http"] },
  { name: "javalin",   hints: ["io.javalin", "Javalin.create", "app.get("] },
  { name: "vertx",     hints: ["io.vertx", "vertx.web", "Router.router"] },
  { name: "spark",     hints: ["spark.Spark", "import static spark.Spark"] },
  { name: "dropwizard", hints: ["io.dropwizard"] },
  { name: "helidon",   hints: ["io.helidon"] },
];

const SPRING_MAPPING: Record<string, HttpMethod> = {
  GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT",
  PatchMapping: "PATCH", DeleteMapping: "DELETE",
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

function extractAnnotations(node: TreeSitter.SyntaxNode, source: string): { name: string; raw: string }[] {
  const anns: { name: string; raw: string }[] = [];
  const parent = node.parent;
  if (!parent) return anns;
  // Siblings before this node
  for (let i = 0; i < parent.childCount; i++) {
    const sib = parent.child(i)!;
    if (sib === node) break;
    if (sib.type === "annotation" || sib.type === "marker_annotation") {
      const raw = getNodeText(sib, source);
      const nameMatch = raw.match(/@(\w+)/);
      if (nameMatch) anns.push({ name: nameMatch[1], raw });
    }
  }
  // Also check direct children (class_body -> modifiers -> annotation)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "modifiers") {
      for (let j = 0; j < child.childCount; j++) {
        const mod = child.child(j)!;
        if (mod.type === "annotation" || mod.type === "marker_annotation") {
          const raw = getNodeText(mod, source);
          const nameMatch = raw.match(/@(\w+)/);
          if (nameMatch) anns.push({ name: nameMatch[1], raw });
        }
      }
    }
  }
  return anns;
}

function extractPathFromAnnotation(raw: string): string | null {
  const m = raw.match(/@\w+\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
  if (!m) return null;
  // Strip any leading/trailing slashes — they're added back when building fullPath.
  return m[1].replace(/^\/+|\/+$/g, "");
}

function walkClassNode(
  node: TreeSitter.SyntaxNode,
  source: string,
  relPath: string,
  moduleDotted: string,
  endpoints: HttpEndpoint[],
  functions: SurfaceFunction[],
): void {
  if (node.type !== "class_declaration") return;

  const classAnns = extractAnnotations(node, source);
  let classPath = "";
  for (const ann of classAnns) {
    if (ann.name === "RequestMapping" || ann.name === "Path") {
      const p = extractPathFromAnnotation(ann.raw);
      if (p) { classPath = p; break; }
    }
  }

  const body = node.children.find((c) => c.type === "class_body");
  if (!body) return;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i)!;
    if (member.type !== "method_declaration") continue;

    const methodAnns = extractAnnotations(member, source);
    let route: { method: HttpMethod; path: string } | null = null;

    // Spring mappings
    for (const ann of methodAnns) {
      if (ann.name in SPRING_MAPPING) {
        const method = SPRING_MAPPING[ann.name];
        const subPath = extractPathFromAnnotation(ann.raw) ?? "";
        const fullPath = "/" + [classPath, subPath].filter(Boolean).join("/").replace(/\/+/g, "/");
        route = { method, path: fullPath };
        break;
      }
      if (ann.name === "RequestMapping") {
        const subPath = extractPathFromAnnotation(ann.raw) ?? "";
        const fullPath = "/" + [classPath, subPath].filter(Boolean).join("/").replace(/\/+/g, "/");
        const methodM = ann.raw.match(/method\s*=\s*RequestMethod\.(\w+)/);
        const method = (methodM ? methodM[1].toUpperCase() : "GET") as HttpMethod;
        route = { method: isHttpMethod(method) ? method : "GET", path: fullPath };
        break;
      }
      // JAX-RS
      if (["GET","POST","PUT","PATCH","DELETE"].includes(ann.name.toUpperCase())) {
        const subPath = (() => {
          for (const a2 of methodAnns) {
            if (a2.name === "Path") return extractPathFromAnnotation(a2.raw) ?? "";
          }
          return "";
        })();
        const fullPath = "/" + [classPath, subPath].filter(Boolean).join("/").replace(/\/+/g, "/");
        const m = ann.name.toUpperCase() as HttpMethod;
        route = { method: isHttpMethod(m) ? m : "GET", path: fullPath };
        break;
      }
    }

    if (route) {
      // Get method name
      let handlerName = "";
      for (let j = 0; j < member.childCount; j++) {
        const ch = member.child(j)!;
        if (ch.type === "identifier") { handlerName = getNodeText(ch, source); break; }
      }
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
        start_line: member.startPosition.row + 1,
        end_line: member.endPosition.row + 1,
      });
    } else {
      // Capture public methods as functions
      const mods = extractAnnotations(member, source).map((a) => a.name);
      const raw = getNodeText(member, source);
      if (raw.includes("public ")) {
        let handlerName = "";
        for (let j = 0; j < member.childCount; j++) {
          const ch = member.child(j)!;
          if (ch.type === "identifier") { handlerName = getNodeText(ch, source); break; }
        }
        functions.push({
          module: moduleDotted,
          qualname: handlerName,
          signature: raw.split("\n")[0].trim().slice(0, 200),
          docstring: "",
          is_async: false,
          is_public: true,
          file_path: relPath,
          start_line: member.startPosition.row + 1,
          end_line: member.endPosition.row + 1,
        });
      }
    }
  }
}

function walkAll(
  node: TreeSitter.SyntaxNode,
  source: string,
  relPath: string,
  moduleDotted: string,
  endpoints: HttpEndpoint[],
  functions: SurfaceFunction[],
): void {
  if (node.type === "class_declaration") {
    walkClassNode(node, source, relPath, moduleDotted, endpoints, functions);
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    walkAll(node.child(i)!, source, relPath, moduleDotted, endpoints, functions);
  }
}

export interface JavaParseOutput {
  endpoints: HttpEndpoint[];
  functions: SurfaceFunction[];
  frameworkHits: string[];
  parseOk: boolean;
}

export function pathJavaToModule(relPath: string): string {
  const noExt = relPath.replace(/\\/g, "/").replace(/\.java$/, "");
  return noExt.split("/").filter(Boolean).join(".");
}

export function parseJavaFile(input: { source: string; relPath: string; module: string }): JavaParseOutput {
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

  walkAll(tree.rootNode, input.source, input.relPath, input.module, endpoints, functions);
  return { endpoints, functions, frameworkHits, parseOk: true };
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build", "target", "bin", "obj",
]);

export function extractJavaSurface(opts: { workingDir: string }): SurfaceManifest {
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
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        const full = path.join(dir, entry.name);
        const relPath = path.relative(workingDir, full);
        let source: string;
        try { source = fs.readFileSync(full, "utf-8"); } catch { continue; }
        const result = parseJavaFile({ source, relPath, module: pathJavaToModule(relPath) });
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
    language: "java",
    framework,
    endpoints,
    functions,
    package_import_root: path.basename(workingDir),
  };
}
