/**
 * Context builder — pre-gathers all generation context CLI-side.
 *
 * Reads source code, resolves exact import paths, and extracts file-level
 * imports for each selected endpoint before the gRPC build call. Zero
 * network calls.
 *
 * Ported from Python utils/context_builder.py.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParamManifestEntry {
  name: string;
  type: string;
  has_default: boolean;
  default: string | null;
  kwonly?: boolean;
}

export interface ContextEndpoint {
  name: string;
  class_name: string | null;
  class_import_path: string | null;
  init_source: string;
  wrapping_pattern: "direct_call" | "class_method" | "requires_wrapper";
  signature: string;
  source_code: string;
  import_path: string;
  docstring: string;
  return_type: string;
  file_path: string;
  conversion_type: string;
  client_dependency: Record<string, unknown> | null;
  file_imports: string[];
  used_names: string[];
  resolved_imports: Record<string, string>;
  parameters: ParamManifestEntry[];
  init_params: ParamManifestEntry[];
  is_async: boolean;
}

export interface ContextBundle {
  endpoints: ContextEndpoint[];
  project_name: string;
  mode: "endpoint_selection" | "custom_prompt";
  project_context?: string;
  query?: string;
  [key: string]: unknown;
}

export interface EndpointLike {
  name: string;
  file_path?: string;
  filePath?: string;
  signature?: string;
  docstring?: string;
  return_type?: string;
  returnType?: string;
  conversion_type?: string;
  client_dependency?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Tree-sitter setup (lazy)
// ---------------------------------------------------------------------------

let _parser: any = null;

function getParser(): any {
  if (_parser) return _parser;
  const TreeSitter = require("tree-sitter");
  const Python = require("tree-sitter-python");
  _parser = new TreeSitter();
  _parser.setLanguage(Python);
  return _parser;
}

function parseFile(filePath: string): { root: any; source: string; codeBytes: Buffer } | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const codeBytes = Buffer.from(source, "utf-8");
  const parser = getParser();
  try {
    const tree = parser.parse(source);
    return { root: tree.rootNode, source, codeBytes };
  } catch {
    return null;
  }
}

function nodeText(node: any, codeBytes: Buffer): string {
  return codeBytes.subarray(node.startIndex, node.endIndex).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Python builtins to exclude from used_names
// ---------------------------------------------------------------------------

const PYTHON_BUILTINS = new Set([
  "Optional", "Any", "Union", "List", "Dict", "Tuple", "Set",
  "int", "str", "float", "bool", "bytes", "list", "dict", "tuple", "set",
  "type", "object", "super", "None", "True", "False",
  "print", "len", "range", "enumerate", "zip", "map", "filter", "sorted",
  "reversed", "min", "max", "sum", "abs", "round", "all", "any",
  "isinstance", "issubclass", "hasattr", "getattr", "setattr", "delattr",
  "callable", "id", "hash", "repr", "format", "input", "open",
  "Exception", "BaseException", "ValueError", "TypeError", "KeyError",
  "IndexError", "AttributeError", "RuntimeError", "OSError", "IOError",
  "FileNotFoundError", "ImportError", "StopIteration", "NotImplementedError",
  "property", "staticmethod", "classmethod",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract exact function source via tree-sitter AST node offsets.
 * Walks all function_definition + decorated_definition nodes.
 */
function readFunctionSource(filePath: string, funcName: string): string {
  const parsed = parseFile(filePath);
  if (!parsed) return "";
  const { root, codeBytes } = parsed;

  function walk(node: any): string | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      let funcNode = child;

      if (child.type === "decorated_definition") {
        const defChild = child.children.find(
          (c: any) => c.type === "function_definition" || c.type === "class_definition",
        );
        if (defChild?.type === "function_definition") funcNode = defChild;
        else continue;
      }

      if (funcNode.type === "function_definition") {
        const nameNode = funcNode.childForFieldName("name");
        if (nameNode && nodeText(nameNode, codeBytes) === funcName) {
          return nodeText(child, codeBytes);
        }
      }

      if (child.type === "class_definition") {
        const bodyNode = child.childForFieldName("body");
        if (bodyNode) {
          const found = walk(bodyNode);
          if (found) return found;
        }
      }
    }
    return null;
  }

  return walk(root) ?? "";
}

/**
 * Resolve import path via pure path arithmetic.
 * e.g., /proj/utils/db.py → "from utils.db import func_name"
 */
function resolveImportPath(
  filePath: string,
  funcName: string,
  workingDir: string,
  className?: string,
): string {
  let rel: string;
  try {
    rel = path.relative(workingDir, filePath);
  } catch {
    rel = path.basename(filePath);
  }

  if (rel.startsWith("..")) {
    const module = path.basename(filePath, ".py");
    return `from ${module} import ${className ?? funcName}`;
  }

  let module = rel.replace(/\\/g, ".").replace(/\//g, ".");
  if (module.endsWith(".py")) module = module.slice(0, -3);
  if (module.endsWith(".__init__")) module = module.slice(0, -9);

  const importName = className ?? funcName;
  return `from ${module} import ${importName}`;
}

/**
 * Walk ClassDef nodes, return [className, classNode] if funcName is a method.
 */
function findParentClass(
  rootNode: any,
  funcName: string,
  codeBytes: Buffer,
): [string, any] | null {
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i);
    if (child.type !== "class_definition") continue;

    const nameNode = child.childForFieldName("name");
    if (!nameNode) continue;
    const className = nodeText(nameNode, codeBytes);

    const bodyNode = child.childForFieldName("body");
    if (!bodyNode) continue;

    for (let j = 0; j < bodyNode.childCount; j++) {
      let funcNode = bodyNode.child(j);
      if (funcNode.type === "decorated_definition") {
        const defChild = funcNode.children.find(
          (c: any) => c.type === "function_definition",
        );
        if (defChild) funcNode = defChild;
        else continue;
      }
      if (funcNode.type === "function_definition") {
        const fnName = funcNode.childForFieldName("name");
        if (fnName && nodeText(fnName, codeBytes) === funcName) {
          return [className, child];
        }
      }
    }
  }
  return null;
}

/**
 * Extract __init__ source from a class node.
 */
function extractClassInitSource(classNode: any, codeBytes: Buffer): string {
  const bodyNode = classNode.childForFieldName("body");
  if (!bodyNode) return "";

  for (let i = 0; i < bodyNode.childCount; i++) {
    let funcNode = bodyNode.child(i);
    if (funcNode.type === "decorated_definition") {
      const defChild = funcNode.children.find(
        (c: any) => c.type === "function_definition",
      );
      if (defChild) funcNode = defChild;
      else continue;
    }
    if (funcNode.type === "function_definition") {
      const nameNode = funcNode.childForFieldName("name");
      if (nameNode && nodeText(nameNode, codeBytes) === "__init__") {
        return nodeText(funcNode, codeBytes);
      }
    }
  }
  return "";
}

/**
 * Extract parameter manifest from a parameters node, skipping self/cls.
 */
function extractParamsFromNode(
  paramsNode: any,
  codeBytes: Buffer,
): ParamManifestEntry[] {
  if (!paramsNode) return [];

  const result: ParamManifestEntry[] = [];
  let kwonly = false;

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (child.type === "list_splat_pattern" || (child.type === "*" && !child.childCount)) {
      kwonly = true;
      continue;
    }

    if (
      child.type === "identifier" ||
      child.type === "typed_parameter" ||
      child.type === "default_parameter" ||
      child.type === "typed_default_parameter"
    ) {
      let name = "";
      let typeStr = "";
      let hasDefault = false;
      let defaultVal: string | null = null;

      if (child.type === "identifier") {
        name = nodeText(child, codeBytes);
      } else if (child.type === "typed_parameter") {
        const nameChild = child.children.find((c: any) => c.type === "identifier");
        const typeChild = child.childForFieldName("type");
        name = nameChild ? nodeText(nameChild, codeBytes) : "";
        typeStr = typeChild ? nodeText(typeChild, codeBytes) : "";
      } else if (child.type === "default_parameter") {
        const nameChild = child.childForFieldName("name");
        const valChild = child.childForFieldName("value");
        name = nameChild ? nodeText(nameChild, codeBytes) : "";
        hasDefault = true;
        defaultVal = valChild ? nodeText(valChild, codeBytes) : null;
      } else if (child.type === "typed_default_parameter") {
        const nameChild = child.childForFieldName("name");
        const typeChild = child.childForFieldName("type");
        const valChild = child.childForFieldName("value");
        name = nameChild ? nodeText(nameChild, codeBytes) : "";
        typeStr = typeChild ? nodeText(typeChild, codeBytes) : "";
        hasDefault = true;
        defaultVal = valChild ? nodeText(valChild, codeBytes) : null;
      }

      if (name === "self" || name === "cls") continue;
      if (!name) continue;

      const entry: ParamManifestEntry = {
        name,
        type: typeStr,
        has_default: hasDefault,
        default: defaultVal,
      };
      if (kwonly) entry.kwonly = true;
      result.push(entry);
    }
  }
  return result;
}

/**
 * Extract __init__ param manifest from a class node.
 */
function extractInitParamManifest(
  classNode: any,
  codeBytes: Buffer,
): ParamManifestEntry[] {
  const bodyNode = classNode.childForFieldName("body");
  if (!bodyNode) return [];

  for (let i = 0; i < bodyNode.childCount; i++) {
    let funcNode = bodyNode.child(i);
    if (funcNode.type === "decorated_definition") {
      const defChild = funcNode.children.find(
        (c: any) => c.type === "function_definition",
      );
      if (defChild) funcNode = defChild;
      else continue;
    }
    if (funcNode.type === "function_definition") {
      const nameNode = funcNode.childForFieldName("name");
      if (nameNode && nodeText(nameNode, codeBytes) === "__init__") {
        const paramsNode = funcNode.childForFieldName("parameters");
        return extractParamsFromNode(paramsNode, codeBytes);
      }
    }
  }
  return [];
}

/**
 * Extract top-level import statements as strings (AST-based, not line-based).
 * Only walks direct children of the module root. Cap at 40.
 */
function extractFileLevelImports(filePath: string): string[] {
  const parsed = parseFile(filePath);
  if (!parsed) return [];

  const imports: string[] = [];

  for (let i = 0; i < parsed.root.childCount; i++) {
    const node = parsed.root.child(i);

    if (node.type === "import_statement") {
      imports.push(nodeText(node, parsed.codeBytes));
    } else if (node.type === "import_from_statement") {
      imports.push(nodeText(node, parsed.codeBytes));
    }

    if (imports.length >= 40) break;
  }

  return imports;
}

/**
 * Extract non-builtin names referenced inside a function body.
 * Chases attribute chains to root identifiers.
 */
function extractUsedNames(filePath: string, funcName: string): string[] {
  const parsed = parseFile(filePath);
  if (!parsed) return [];
  const { root, codeBytes } = parsed;

  function findFuncBody(node: any): any | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      let funcNode = child;

      if (child.type === "decorated_definition") {
        const defChild = child.children.find(
          (c: any) => c.type === "function_definition",
        );
        if (defChild) funcNode = defChild;
        else continue;
      }

      if (funcNode.type === "function_definition") {
        const nameNode = funcNode.childForFieldName("name");
        if (nameNode && nodeText(nameNode, codeBytes) === funcName) {
          return funcNode.childForFieldName("body");
        }
      }

      if (child.type === "class_definition") {
        const bodyNode = child.childForFieldName("body");
        if (bodyNode) {
          const found = findFuncBody(bodyNode);
          if (found) return found;
        }
      }
    }
    return null;
  }

  const body = findFuncBody(root);
  if (!body) return [];

  const names = new Set<string>();

  function walkBody(node: any): void {
    if (node.type === "identifier") {
      const name = nodeText(node, codeBytes);
      if (!PYTHON_BUILTINS.has(name)) {
        names.add(name);
      }
    } else if (node.type === "attribute") {
      let attrRoot = node.childForFieldName("object");
      while (attrRoot && attrRoot.type === "attribute") {
        attrRoot = attrRoot.childForFieldName("object");
      }
      if (attrRoot && attrRoot.type === "identifier") {
        const name = nodeText(attrRoot, codeBytes);
        if (!PYTHON_BUILTINS.has(name)) {
          names.add(name);
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      walkBody(node.child(i));
    }
  }

  walkBody(body);
  return [...names].sort();
}

/**
 * Map used names to their import statement from the file's top-level imports.
 */
function resolveNeededImports(
  filePath: string,
  usedNames: string[],
): Record<string, string> {
  if (usedNames.length === 0) return {};

  const parsed = parseFile(filePath);
  if (!parsed) return {};

  const nameToStmt: Record<string, string> = {};

  for (let i = 0; i < parsed.root.childCount; i++) {
    const node = parsed.root.child(i);
    const stmtText = nodeText(node, parsed.codeBytes);

    if (node.type === "import_statement") {
      // import X, import X as Y, import X.Y
      for (let j = 0; j < node.childCount; j++) {
        const child = node.child(j);
        if (child.type === "dotted_name") {
          const fullName = nodeText(child, parsed.codeBytes);
          nameToStmt[fullName.split(".")[0]] = stmtText;
        } else if (child.type === "aliased_import") {
          const aliasNode = child.childForFieldName("alias");
          const nameNode = child.childForFieldName("name");
          const effective = aliasNode
            ? nodeText(aliasNode, parsed.codeBytes)
            : nameNode
              ? nodeText(nameNode, parsed.codeBytes).split(".")[0]
              : "";
          if (effective) nameToStmt[effective] = stmtText;
        }
      }
    } else if (node.type === "import_from_statement") {
      // from X import Y, from X import Y as Z
      for (let j = 0; j < node.childCount; j++) {
        const child = node.child(j);
        if (child.type === "dotted_name" || child.type === "identifier") {
          // This could be the module name or an imported name
          // Skip the module name (comes after "from" keyword)
          const prevSibling = child.previousSibling;
          if (prevSibling && nodeText(prevSibling, parsed.codeBytes) === "import") {
            const name = nodeText(child, parsed.codeBytes);
            nameToStmt[name] = stmtText;
          }
        } else if (child.type === "aliased_import") {
          const aliasNode = child.childForFieldName("alias");
          const nameNode = child.childForFieldName("name");
          const effective = aliasNode
            ? nodeText(aliasNode, parsed.codeBytes)
            : nameNode
              ? nodeText(nameNode, parsed.codeBytes)
              : "";
          if (effective) nameToStmt[effective] = stmtText;
        }
      }
    }
  }

  const usedSet = new Set(usedNames);
  const result: Record<string, string> = {};
  for (const [name, stmt] of Object.entries(nameToStmt)) {
    if (usedSet.has(name)) result[name] = stmt;
  }
  return result;
}

/**
 * Extract param manifest for a named function.
 */
function extractParamManifest(
  filePath: string,
  funcName: string,
): ParamManifestEntry[] {
  const parsed = parseFile(filePath);
  if (!parsed) return [];
  const { root, codeBytes } = parsed;

  function findFunc(node: any): any | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      let funcNode = child;

      if (child.type === "decorated_definition") {
        const defChild = child.children.find(
          (c: any) => c.type === "function_definition",
        );
        if (defChild) funcNode = defChild;
        else continue;
      }

      if (funcNode.type === "function_definition") {
        const nameNode = funcNode.childForFieldName("name");
        if (nameNode && nodeText(nameNode, codeBytes) === funcName) {
          return funcNode;
        }
      }

      if (child.type === "class_definition") {
        const bodyNode = child.childForFieldName("body");
        if (bodyNode) {
          const found = findFunc(bodyNode);
          if (found) return found;
        }
      }
    }
    return null;
  }

  const funcNode = findFunc(root);
  if (!funcNode) return [];

  const paramsNode = funcNode.childForFieldName("parameters");
  return extractParamsFromNode(paramsNode, codeBytes);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build complete context bundle for selected endpoints. Zero network calls.
 */
export function buildContextBundle(
  selectedEndpoints: EndpointLike[],
  workingDir: string,
  _synapseDir: string,
): ContextBundle {
  const endpoints: ContextEndpoint[] = [];

  for (const ep of selectedEndpoints) {
    const filePath = ep.file_path ?? ep.filePath ?? "";
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workingDir, filePath);

    const sourceCode = readFunctionSource(absPath, ep.name);
    const fileImports = extractFileLevelImports(absPath);

    let className: string | null = null;
    let classImportPath: string | null = null;
    let initSource = "";
    let initParams: ParamManifestEntry[] = [];
    let wrappingPattern: "direct_call" | "class_method" | "requires_wrapper" = "direct_call";
    let conversionType = ep.conversion_type ?? "ready";

    const parsed = parseFile(absPath);
    if (parsed) {
      const parent = findParentClass(parsed.root, ep.name, parsed.codeBytes);
      if (parent) {
        const [cls, classNode] = parent;
        className = cls;
        classImportPath = resolveImportPath(absPath, ep.name, workingDir, cls);
        initSource = extractClassInitSource(classNode, parsed.codeBytes);
        initParams = extractInitParamManifest(classNode, parsed.codeBytes);
        wrappingPattern = "class_method";
        conversionType = "class_method";
      }
    }

    if (wrappingPattern !== "class_method" && ep.conversion_type === "requires_wrapper") {
      wrappingPattern = "requires_wrapper";
    }

    const importPath = resolveImportPath(absPath, ep.name, workingDir, className ?? undefined);

    let relPath: string;
    try {
      relPath = path.relative(workingDir, absPath);
    } catch {
      relPath = filePath;
    }

    let clientDep: Record<string, unknown> | null = null;
    const cd = ep.client_dependency;
    if (cd && typeof cd === "object") {
      clientDep = cd as Record<string, unknown>;
    }

    const usedNames = extractUsedNames(absPath, ep.name);
    const resolvedImports = resolveNeededImports(absPath, usedNames);
    const parameters = extractParamManifest(absPath, ep.name);

    endpoints.push({
      name: ep.name,
      class_name: className,
      class_import_path: classImportPath,
      init_source: initSource,
      wrapping_pattern: wrappingPattern,
      signature: ep.signature ?? `def ${ep.name}(...)`,
      source_code: sourceCode,
      import_path: importPath,
      docstring: ep.docstring ?? "",
      return_type: ep.return_type ?? ep.returnType ?? "Any",
      file_path: relPath,
      conversion_type: conversionType,
      client_dependency: clientDep,
      file_imports: fileImports,
      used_names: usedNames,
      resolved_imports: resolvedImports,
      parameters,
      init_params: initParams,
      is_async: /async\s+def\s/.test(sourceCode),
    });
  }

  const hasTs = endpoints.some((ep: any) => ep.file_path?.match(/\.(ts|js|tsx)$/));
  return {
    endpoints,
    project_name: path.basename(workingDir),
    mode: "endpoint_selection",
    language: hasTs ? "typescript" : "python",
  };
}
