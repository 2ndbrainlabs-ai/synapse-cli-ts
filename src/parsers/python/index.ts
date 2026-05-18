// src/parsers/python/index.ts
//
// PythonParser class implementing the LanguageParser interface.
// Uses tree-sitter for all AST operations, delegating to:
//   - chunk-extractor.ts  (extractChunks)
//   - function-extractor.ts (extractAllFunctions / per-file extraction)
//   - inline parseModule   (codebase analyzer module parsing)

import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import type {
  AnalyzerFunctionInfo,
  ChunkInfo,
  ClassInfo,
  FunctionInfo,
  LanguageParser,
  ModuleInfo,
} from "../types.js";
import { extractChunks } from "./chunk-extractor.js";
import {
  getChildByFieldName,
  getNodeText,
  extractDecoratorName,
} from "./ast-utils.js";
import path from "node:path";

const require = createRequire(import.meta.url);

// Re-export the standalone directory walker for direct use
export { extractAllFunctions } from "./function-extractor.js";

export class PythonParser implements LanguageParser {
  readonly extensions = [".py"];
  readonly language = "Python";

  private parser: any = null;

  private getParser(): any {
    if (this.parser) return this.parser;
    const TreeSitter = require("tree-sitter");
    const Python = require("tree-sitter-python");
    this.parser = new TreeSitter();
    this.parser.setLanguage(Python);
    return this.parser;
  }

  // ---------------------------------------------------------------------------
  // LanguageParser.extractChunks
  // ---------------------------------------------------------------------------

  extractChunks(filePath: string, source: Buffer): ChunkInfo[] {
    const parser = this.getParser();
    const tree = parser.parse(source.toString("utf-8"));
    return extractChunks(tree.rootNode, source, filePath);
  }

  // ---------------------------------------------------------------------------
  // LanguageParser.extractFunctions  (per-file, with 6-tier filtering)
  // ---------------------------------------------------------------------------

  extractFunctions(
    _filePath: string,
    source: string,
    relPath: string,
  ): FunctionInfo[] {
    const parser = this.getParser();
    const codeBytes = Buffer.from(source, "utf-8");
    const tree = parser.parse(source);
    return extractFunctionsFromTree(tree.rootNode, codeBytes, relPath);
  }

  // ---------------------------------------------------------------------------
  // LanguageParser.parseModule  (for codebase_analyzer equivalent)
  // ---------------------------------------------------------------------------

  parseModule(filePath: string, source: string): ModuleInfo {
    const parser = this.getParser();
    const codeBytes = Buffer.from(source, "utf-8");
    let tree: any;
    try {
      tree = parser.parse(source);
    } catch {
      return {
        filePath,
        moduleName: path.basename(filePath, ".py"),
        imports: [],
        classes: [],
        functions: [],
      };
    }
    return parseModuleFromTree(tree.rootNode, codeBytes, filePath);
  }
}

// =============================================================================
// extractFunctionsFromTree — per-file filtered function extraction
// =============================================================================

// Duplicated filter constants from function-extractor so this file is
// self-contained for single-file use (the directory-walk constants are only
// needed in extractAllFunctions).

const SKIP_DECORATORS = new Set([
  "validator",
  "field_validator",
  "property",
  "cached_property",
  "staticmethod",
  "abstractmethod",
  "classmethod",
  "dataclass",
  "fixture",
  "mock",
  "patch",
  "pytest",
]);

const SKIP_NAME_PREFIXES: string[] = ["is_", "has_", "can_"];

const SKIP_NAME_EXACT = new Set([
  "setup",
  "teardown",
  "configure",
  "initialize",
  "setUp",
  "tearDown",
  "setUpClass",
  "tearDownClass",
  "setUpModule",
  "tearDownModule",
]);

/**
 * Walk a parsed tree and extract FunctionInfo entries, applying tiers 4-6.
 * This is the single-file counterpart of the full extractAllFunctions.
 */
function extractFunctionsFromTree(
  rootNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
  relPath: string,
): FunctionInfo[] {
  const results: FunctionInfo[] = [];

  function visit(node: TreeSitter.SyntaxNode): void {
    let funcNode: TreeSitter.SyntaxNode | null = null;
    let decorators: TreeSitter.SyntaxNode[] = [];

    if (node.type === "decorated_definition") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === "decorator") {
          decorators.push(child);
        } else if (child.type === "function_definition") {
          funcNode = child;
        }
      }
    } else if (node.type === "function_definition") {
      funcNode = node;
    }

    if (funcNode) {
      const info = buildFunctionInfo(funcNode, decorators, codeBytes, relPath);
      if (info) results.push(info);
    }

    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i)!);
    }
  }

  visit(rootNode);
  return results;
}

function buildFunctionInfo(
  funcNode: TreeSitter.SyntaxNode,
  decorators: TreeSitter.SyntaxNode[],
  codeBytes: Buffer,
  relPath: string,
): FunctionInfo | null {
  const nameNode = getChildByFieldName(funcNode, "name");
  if (!nameNode) return null;
  const name = getNodeText(nameNode, codeBytes);

  // Tier 4: private / dunder
  if (name.startsWith("_")) return null;

  // Tier 4: test functions
  const nameLower = name.toLowerCase();
  if (nameLower.startsWith("test") || name.startsWith("Test")) return null;

  // Tier 5: skip-decorator check
  for (const dec of decorators) {
    const decName = extractDecoratorName(dec, codeBytes);
    if (decName && SKIP_DECORATORS.has(decName.toLowerCase())) return null;
  }

  // Tier 6: helper / lifecycle name patterns
  if (SKIP_NAME_PREFIXES.some((p) => nameLower.startsWith(p))) return null;
  if (SKIP_NAME_EXACT.has(name) || SKIP_NAME_EXACT.has(nameLower)) return null;

  // ── Extract metadata ──

  const funcText = getNodeText(funcNode, codeBytes);
  const isAsync = funcText.trimStart().startsWith("async ");

  const { paramNames, paramTypes, paramDefaults } = extractParams(
    funcNode,
    codeBytes,
  );

  const returnType = extractRetType(funcNode, codeBytes);
  const docstring = extractDocStr(funcNode, codeBytes);

  // Build signature
  const sigParts: string[] = [];
  for (let i = 0; i < paramNames.length; i++) {
    const n = paramNames[i];
    const t = paramTypes[i];
    const d = paramDefaults[i];
    if (n === "self" || n === "cls") continue;
    if (t && d !== null) {
      sigParts.push(`${n}: ${t} = ${d}`);
    } else if (t) {
      sigParts.push(`${n}: ${t}`);
    } else if (d !== null) {
      sigParts.push(`${n} = ${d}`);
    } else {
      sigParts.push(n);
    }
  }
  const paramsStr = sigParts.join(", ");
  const retStr = returnType ? ` -> ${returnType}` : "";
  const asyncPrefix = isAsync ? "async " : "";
  const signature = `${asyncPrefix}def ${name}(${paramsStr})${retStr}`;

  // Endpoint type
  const hasSelf =
    paramNames.includes("self") || paramNames.includes("cls");
  let endpointType = hasSelf ? "method" : "function";
  for (const dec of decorators) {
    const decName = extractDecoratorName(dec, codeBytes);
    if (["get", "post", "put", "delete", "patch", "api_route"].includes(decName)) {
      endpointType = "fastapi";
      break;
    }
    if (decName === "route") {
      endpointType = "flask";
      break;
    }
  }

  return {
    name,
    filePath: relPath,
    signature,
    docstring,
    returnType,
    isAsync,
    lineNumber: funcNode.startPosition.row + 1,
    paramNames,
    paramTypes,
    paramDefaults,
    endpointType,
  };
}

// =============================================================================
// Parameter / return-type / docstring helpers (shared with index.ts scope)
// =============================================================================

function extractParams(
  funcNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): {
  paramNames: string[];
  paramTypes: string[];
  paramDefaults: (string | null)[];
} {
  const paramNames: string[] = [];
  const paramTypes: string[] = [];
  const paramDefaults: (string | null)[] = [];

  const paramsNode = getChildByFieldName(funcNode, "parameters");
  if (!paramsNode) return { paramNames, paramTypes, paramDefaults };

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i)!;

    if (
      child.type === "(" ||
      child.type === ")" ||
      child.type === "," ||
      child.type === "*" ||
      child.type === "/" ||
      child.type === "**"
    ) {
      continue;
    }

    if (child.type === "identifier") {
      paramNames.push(getNodeText(child, codeBytes));
      paramTypes.push("");
      paramDefaults.push(null);
    } else if (child.type === "default_parameter") {
      const nameChild = getChildByFieldName(child, "name");
      const valueChild = getChildByFieldName(child, "value");
      paramNames.push(nameChild ? getNodeText(nameChild, codeBytes) : "");
      paramTypes.push("");
      paramDefaults.push(
        valueChild ? getNodeText(valueChild, codeBytes) : null,
      );
    } else if (child.type === "typed_parameter") {
      const nameChild = getChildByFieldName(child, "name") ?? child.child(0);
      const typeChild = getChildByFieldName(child, "type");
      paramNames.push(nameChild ? getNodeText(nameChild, codeBytes) : "");
      paramTypes.push(typeChild ? getNodeText(typeChild, codeBytes) : "");
      paramDefaults.push(null);
    } else if (child.type === "typed_default_parameter") {
      const nameChild = getChildByFieldName(child, "name");
      const typeChild = getChildByFieldName(child, "type");
      const valueChild = getChildByFieldName(child, "value");
      paramNames.push(nameChild ? getNodeText(nameChild, codeBytes) : "");
      paramTypes.push(typeChild ? getNodeText(typeChild, codeBytes) : "");
      paramDefaults.push(
        valueChild ? getNodeText(valueChild, codeBytes) : null,
      );
    } else if (
      child.type === "list_splat_pattern" ||
      child.type === "dictionary_splat_pattern"
    ) {
      const inner = child.child(0);
      if (inner) {
        const prefix =
          child.type === "list_splat_pattern" ? "*" : "**";
        paramNames.push(prefix + getNodeText(inner, codeBytes));
        paramTypes.push("");
        paramDefaults.push(null);
      }
    }
  }

  return { paramNames, paramTypes, paramDefaults };
}

function extractRetType(
  funcNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): string {
  const retNode = getChildByFieldName(funcNode, "return_type");
  if (!retNode) return "";
  return getNodeText(retNode, codeBytes);
}

function extractDocStr(
  funcNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): string {
  const body = getChildByFieldName(funcNode, "body");
  if (!body || body.childCount === 0) return "";

  const firstStmt = body.child(0);
  if (!firstStmt || firstStmt.type !== "expression_statement") return "";

  const strNode = firstStmt.child(0);
  if (!strNode || strNode.type !== "string") return "";

  let raw = getNodeText(strNode, codeBytes);

  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    raw = raw.slice(3, -3);
  } else if (raw.startsWith("'''") && raw.endsWith("'''")) {
    raw = raw.slice(3, -3);
  } else if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1);
  } else if (raw.startsWith("'") && raw.endsWith("'")) {
    raw = raw.slice(1, -1);
  }

  return raw.trim().slice(0, 500);
}

// =============================================================================
// parseModuleFromTree — for codebase analyzer (ModuleInfo extraction)
// =============================================================================

/**
 * Parse a tree-sitter AST and extract imports, classes, and top-level
 * functions, mirroring the Python `codebase_analyzer.py` implementation.
 */
function parseModuleFromTree(
  rootNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
  filePath: string,
): ModuleInfo {
  const imports: string[] = [];
  const classes: ClassInfo[] = [];
  const functions: AnalyzerFunctionInfo[] = [];

  const moduleName = path.basename(filePath, ".py");

  // Walk all nodes for imports (they can appear anywhere)
  function collectImports(node: TreeSitter.SyntaxNode): void {
    if (node.type === "import_statement") {
      // import foo, bar
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === "dotted_name" || child.type === "aliased_import") {
          const nameNode =
            child.type === "aliased_import"
              ? getChildByFieldName(child, "name")
              : child;
          if (nameNode) {
            imports.push(getNodeText(nameNode, codeBytes));
          }
        }
      }
    } else if (node.type === "import_from_statement") {
      // from foo import bar
      const moduleNode = getChildByFieldName(node, "module_name");
      if (moduleNode) {
        imports.push(getNodeText(moduleNode, codeBytes));
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      collectImports(node.child(i)!);
    }
  }

  collectImports(rootNode);

  // Process only top-level children for classes and functions
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i)!;

    if (child.type === "function_definition") {
      functions.push(buildAnalyzerFunctionInfo(child, codeBytes));
    } else if (child.type === "decorated_definition") {
      // Check if the inner definition is a function or class
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j)!;
        if (inner.type === "function_definition") {
          functions.push(buildAnalyzerFunctionInfo(inner, codeBytes));
        } else if (inner.type === "class_definition") {
          classes.push(buildClassInfo(inner, codeBytes));
        }
      }
    } else if (child.type === "class_definition") {
      classes.push(buildClassInfo(child, codeBytes));
    }
  }

  // Deduplicate imports
  const uniqueImports = [...new Set(imports)];

  return {
    filePath,
    moduleName,
    imports: uniqueImports,
    classes,
    functions,
  };
}

// =============================================================================
// AnalyzerFunctionInfo builder
// =============================================================================

function buildAnalyzerFunctionInfo(
  funcNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): AnalyzerFunctionInfo {
  const nameNode = getChildByFieldName(funcNode, "name");
  const name = nameNode ? getNodeText(nameNode, codeBytes) : "unknown";

  const funcText = getNodeText(funcNode, codeBytes);
  const isAsync = funcText.trimStart().startsWith("async ");

  // Parameters (just names for the analyzer)
  const parameters: string[] = [];
  const paramsNode = getChildByFieldName(funcNode, "parameters");
  if (paramsNode) {
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i)!;
      if (child.type === "identifier") {
        parameters.push(getNodeText(child, codeBytes));
      } else if (
        child.type === "typed_parameter" ||
        child.type === "default_parameter" ||
        child.type === "typed_default_parameter"
      ) {
        const paramName = getChildByFieldName(child, "name") ?? child.child(0);
        if (paramName) parameters.push(getNodeText(paramName, codeBytes));
      } else if (
        child.type === "list_splat_pattern" ||
        child.type === "dictionary_splat_pattern"
      ) {
        const inner = child.child(0);
        if (inner) {
          const prefix =
            child.type === "list_splat_pattern" ? "*" : "**";
          parameters.push(prefix + getNodeText(inner, codeBytes));
        }
      }
    }
  }

  // Return type
  const retNode = getChildByFieldName(funcNode, "return_type");
  const returnType = retNode ? getNodeText(retNode, codeBytes) : "Any";

  // Build signature with type annotations
  const sigParts: string[] = [];
  if (paramsNode) {
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i)!;
      if (
        child.type === "(" ||
        child.type === ")" ||
        child.type === "," ||
        child.type === "*" ||
        child.type === "/" ||
        child.type === "**"
      ) {
        continue;
      }

      if (child.type === "identifier") {
        sigParts.push(getNodeText(child, codeBytes));
      } else if (child.type === "typed_parameter") {
        const paramName = getChildByFieldName(child, "name") ?? child.child(0);
        const typeNode = getChildByFieldName(child, "type");
        const pName = paramName ? getNodeText(paramName, codeBytes) : "";
        const pType = typeNode ? getNodeText(typeNode, codeBytes) : "";
        sigParts.push(pType ? `${pName}: ${pType}` : pName);
      } else if (child.type === "default_parameter") {
        const paramName = getChildByFieldName(child, "name");
        sigParts.push(paramName ? getNodeText(paramName, codeBytes) : "");
      } else if (child.type === "typed_default_parameter") {
        const paramName = getChildByFieldName(child, "name");
        const typeNode = getChildByFieldName(child, "type");
        const pName = paramName ? getNodeText(paramName, codeBytes) : "";
        const pType = typeNode ? getNodeText(typeNode, codeBytes) : "";
        sigParts.push(pType ? `${pName}: ${pType}` : pName);
      } else if (
        child.type === "list_splat_pattern" ||
        child.type === "dictionary_splat_pattern"
      ) {
        const inner = child.child(0);
        if (inner) {
          const prefix =
            child.type === "list_splat_pattern" ? "*" : "**";
          sigParts.push(prefix + getNodeText(inner, codeBytes));
        }
      }
    }
  }
  const signature = `def ${name}(${sigParts.join(", ")}) -> ${returnType}`;

  // Docstring
  const docstring = extractDocStr(funcNode, codeBytes);

  return {
    name,
    lineNumber: funcNode.startPosition.row + 1,
    signature,
    docstring,
    isAsync,
    parameters,
    returnType,
  };
}

// =============================================================================
// ClassInfo builder
// =============================================================================

function buildClassInfo(
  classNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): ClassInfo {
  const nameNode = getChildByFieldName(classNode, "name");
  const name = nameNode ? getNodeText(nameNode, codeBytes) : "unknown";

  // Base classes
  const bases: string[] = [];
  const superclasses = getChildByFieldName(classNode, "superclasses");
  if (superclasses) {
    // argument_list contains the base class expressions
    for (let i = 0; i < superclasses.childCount; i++) {
      const child = superclasses.child(i)!;
      if (child.type !== "(" && child.type !== ")" && child.type !== ",") {
        bases.push(getNodeText(child, codeBytes));
      }
    }
  }

  // Docstring — first expression_statement > string in class body
  let docstring = "";
  const body = getChildByFieldName(classNode, "body");
  if (body && body.childCount > 0) {
    const firstStmt = body.child(0);
    if (firstStmt && firstStmt.type === "expression_statement") {
      const strNode = firstStmt.child(0);
      if (strNode && strNode.type === "string") {
        let raw = getNodeText(strNode, codeBytes);
        if (raw.startsWith('"""') && raw.endsWith('"""')) {
          raw = raw.slice(3, -3);
        } else if (raw.startsWith("'''") && raw.endsWith("'''")) {
          raw = raw.slice(3, -3);
        } else if (raw.startsWith('"') && raw.endsWith('"')) {
          raw = raw.slice(1, -1);
        } else if (raw.startsWith("'") && raw.endsWith("'")) {
          raw = raw.slice(1, -1);
        }
        docstring = raw.trim();
      }
    }
  }

  // Methods
  const methods: AnalyzerFunctionInfo[] = [];
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i)!;
      if (child.type === "function_definition") {
        methods.push(buildAnalyzerFunctionInfo(child, codeBytes));
      } else if (child.type === "decorated_definition") {
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j)!;
          if (inner.type === "function_definition") {
            methods.push(buildAnalyzerFunctionInfo(inner, codeBytes));
          }
        }
      }
    }
  }

  return {
    name,
    lineNumber: classNode.startPosition.row + 1,
    docstring,
    methods,
    bases,
  };
}
