// src/parsers/python/function-extractor.ts
//
// Port of Python's `utils/endpoint_extractor.py`.
// 6-tier filtered function extraction for MCP tool candidate detection.
// Uses tree-sitter AST (not Python's ast module).

import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import type { FunctionInfo } from "../types.js";
import { extractDecoratorName, getChildByFieldName, getNodeText } from "./ast-utils.js";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

// ── Tier 1: Directory names to skip entirely ────────────────────────────────
const SKIP_DIRS = new Set([
  "__pycache__",
  ".git",
  ".venv",
  "venv",
  "node_modules",
  ".synapse",
  "env",
  ".env",
  "tests",
  "test",
  "testing",
  "dist",
  "build",
  ".egg-info",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
]);

// ── Tier 2: Exact filenames to skip ─────────────────────────────────────────
const SKIP_FILENAMES = new Set([
  "mcp_server.py",
  "setup.py",
  "conftest.py",
  "noxfile.py",
  "__init__.py",
]);

// ── Tier 3: Path-segment patterns (normalised to forward-slash) ─────────────
const SKIP_PATH_SEGMENTS: string[] = [
  "/tests/",
  "/test/",
  "/_tests/",
  "/testing/",
  "/test_",
  "\\tests\\",
  "\\test\\",
  "\\_tests\\",
  "/_async/",
  "/_sync/",
  "/client/",
  "/clients/",
  "/plugins/",
  "/plugin/",
  "/transport/",
  "/transports/",
  "/connection/",
  "/connections/",
  "/compat/",
  "/serializer/",
  "/serializers/",
  "/exceptions/",
];

// ── Tier 2 (partial): File-name patterns ────────────────────────────────────
const SKIP_FILE_NAMES_PARTIAL: string[] = [
  "test_",
  "_test.py",
  "tests.py",
  "fixtures.py",
  "test.py",
];

// ── Tier 5: Decorator names that mark non-tool functions ────────────────────
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

// ── Tier 6: Name patterns that mark helper / lifecycle functions ────────────
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

// =============================================================================
// Tree-sitter parser (lazy-loaded singleton)
// =============================================================================

let _parser: any = null;

function getParser(): any {
  if (_parser) return _parser;
  const TreeSitter = require("tree-sitter");
  const Python = require("tree-sitter-python");
  _parser = new TreeSitter();
  _parser.setLanguage(Python);
  return _parser;
}

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Extract Python functions from a project as FunctionInfo objects.
 *
 * Uses pure AST analysis -- no AI, no network calls.  The backend's
 * DetectEndpoints RPC will classify which are good MCP tool candidates.
 *
 * Applies all 6 filter tiers (directory, file, path, function name,
 * decorator, name-pattern) matching the Python implementation exactly.
 */
export function extractAllFunctions(workingDir: string): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  walkDirectory(workingDir, workingDir, results);
  return results;
}

// =============================================================================
// Directory walking
// =============================================================================

function walkDirectory(
  dir: string,
  workingDir: string,
  results: FunctionInfo[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Tier 1: skip ignored directories + hidden directories
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      walkDirectory(fullPath, workingDir, results);
      continue;
    }

    if (!entry.name.endsWith(".py")) continue;

    // Tier 2: exact filename skip
    if (SKIP_FILENAMES.has(entry.name)) continue;

    let relPath: string;
    try {
      relPath = path.relative(workingDir, fullPath);
    } catch {
      relPath = fullPath;
    }

    // Tier 2 (partial) + Tier 3 (path segments)
    if (shouldSkipFile(entry.name, relPath)) continue;

    const functions = extractFromFile(fullPath, relPath);
    results.push(...functions);
  }
}

// =============================================================================
// File-level filtering
// =============================================================================

function shouldSkipFile(filename: string, relPath: string): boolean {
  const fnameLower = filename.toLowerCase();

  // Tier 2 partial -- test file name patterns
  if (SKIP_FILE_NAMES_PARTIAL.some((pat) => fnameLower.includes(pat))) {
    return true;
  }

  // Tier 3 -- path-segment patterns
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  const wrapped = `/${norm}/`;
  if (SKIP_PATH_SEGMENTS.some((seg) => wrapped.includes(seg))) {
    return true;
  }

  // Tier 3 -- underscore-prefixed directories (e.g. /_internal/, /_helpers/)
  const parts = norm.split("/");
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith("_") && part !== "__pycache__") {
      return true;
    }
  }

  return false;
}

// =============================================================================
// File parsing
// =============================================================================

function extractFromFile(absPath: string, relPath: string): FunctionInfo[] {
  let source: string;
  try {
    source = fs.readFileSync(absPath, "utf-8");
  } catch {
    return [];
  }

  const parser = getParser();
  const codeBytes = Buffer.from(source, "utf-8");

  let tree: any;
  try {
    tree = parser.parse(source);
  } catch {
    return [];
  }

  const results: FunctionInfo[] = [];
  walkFunctions(tree.rootNode, codeBytes, relPath, results);
  return results;
}

// =============================================================================
// Function-level walking & filtering
// =============================================================================

function walkFunctions(
  rootNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
  relPath: string,
  results: FunctionInfo[],
): void {
  function visit(node: TreeSitter.SyntaxNode): void {
    // Handle both bare function_definition and decorated_definition wrapping one
    let funcNode: TreeSitter.SyntaxNode | null = null;
    let decorators: TreeSitter.SyntaxNode[] = [];

    if (node.type === "decorated_definition") {
      // Gather decorator children
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === "decorator") {
          decorators.push(child);
        } else if (
          child.type === "function_definition" ||
          child.type === "class_definition"
        ) {
          if (child.type === "function_definition") {
            funcNode = child;
          }
        }
      }
    } else if (node.type === "function_definition") {
      funcNode = node;
    }

    if (funcNode) {
      const info = processFunctionNode(funcNode, decorators, codeBytes, relPath);
      if (info) {
        results.push(info);
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i)!);
    }
  }

  visit(rootNode);
}

// =============================================================================
// Single-function processing (tiers 4-6 + extraction)
// =============================================================================

function processFunctionNode(
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

  // ── Passed all filters — extract metadata ──

  // Is async?
  // In tree-sitter-python the parent of an async function is still
  // "function_definition" but has an "async" keyword child. We check
  // if the text starts with "async".
  const funcText = getNodeText(funcNode, codeBytes);
  const isAsync = funcText.trimStart().startsWith("async ");

  // Parameters
  const { paramNames, paramTypes, paramDefaults } = extractParameters(
    funcNode,
    codeBytes,
  );

  // Return type
  const returnType = extractReturnType(funcNode, codeBytes);

  // Docstring
  const docstring = extractDocstring(funcNode, codeBytes);

  // Build signature string (matching Python implementation)
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
  const endpointType = detectEndpointType(decorators, paramNames, codeBytes);

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
// Parameter extraction from tree-sitter
// =============================================================================

function extractParameters(
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

    // Skip punctuation: ( , ) * / **
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
      // Simple parameter with no annotation or default
      paramNames.push(getNodeText(child, codeBytes));
      paramTypes.push("");
      paramDefaults.push(null);
    } else if (child.type === "default_parameter") {
      // param = default
      const nameChild = getChildByFieldName(child, "name");
      const valueChild = getChildByFieldName(child, "value");
      paramNames.push(nameChild ? getNodeText(nameChild, codeBytes) : "");
      paramTypes.push("");
      paramDefaults.push(valueChild ? getNodeText(valueChild, codeBytes) : null);
    } else if (child.type === "typed_parameter") {
      // param: type
      const nameChild = getChildByFieldName(child, "name") ?? child.child(0);
      const typeChild = getChildByFieldName(child, "type");
      paramNames.push(nameChild ? getNodeText(nameChild, codeBytes) : "");
      paramTypes.push(typeChild ? getNodeText(typeChild, codeBytes) : "");
      paramDefaults.push(null);
    } else if (child.type === "typed_default_parameter") {
      // param: type = default
      const nameChild = getChildByFieldName(child, "name");
      const typeChild = getChildByFieldName(child, "type");
      const valueChild = getChildByFieldName(child, "value");
      paramNames.push(nameChild ? getNodeText(nameChild, codeBytes) : "");
      paramTypes.push(typeChild ? getNodeText(typeChild, codeBytes) : "");
      paramDefaults.push(valueChild ? getNodeText(valueChild, codeBytes) : null);
    } else if (child.type === "list_splat_pattern" || child.type === "dictionary_splat_pattern") {
      // *args or **kwargs
      const inner = child.child(0);
      if (inner) {
        const prefix = child.type === "list_splat_pattern" ? "*" : "**";
        paramNames.push(prefix + getNodeText(inner, codeBytes));
        paramTypes.push("");
        paramDefaults.push(null);
      }
    }
  }

  return { paramNames, paramTypes, paramDefaults };
}

// =============================================================================
// Return type extraction
// =============================================================================

function extractReturnType(
  funcNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): string {
  const retNode = getChildByFieldName(funcNode, "return_type");
  if (!retNode) return "";
  return getNodeText(retNode, codeBytes);
}

// =============================================================================
// Docstring extraction
// =============================================================================

function extractDocstring(
  funcNode: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): string {
  const body = getChildByFieldName(funcNode, "body");
  if (!body || body.childCount === 0) return "";

  const firstStmt = body.child(0);
  if (!firstStmt || firstStmt.type !== "expression_statement") return "";

  // The expression_statement should contain a string node (the docstring)
  const strNode = firstStmt.child(0);
  if (!strNode || strNode.type !== "string") return "";

  let raw = getNodeText(strNode, codeBytes);

  // Strip triple-quote wrappers
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    raw = raw.slice(3, -3);
  } else if (raw.startsWith("'''") && raw.endsWith("'''")) {
    raw = raw.slice(3, -3);
  } else if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1);
  } else if (raw.startsWith("'") && raw.endsWith("'")) {
    raw = raw.slice(1, -1);
  }

  // Truncate to 500 chars (matching Python implementation)
  return raw.trim().slice(0, 500);
}

// =============================================================================
// Endpoint type detection
// =============================================================================

function detectEndpointType(
  decorators: TreeSitter.SyntaxNode[],
  paramNames: string[],
  codeBytes: Buffer,
): string {
  const hasSelf = paramNames.includes("self") || paramNames.includes("cls");

  for (const dec of decorators) {
    const decName = extractDecoratorName(dec, codeBytes);
    if (
      decName === "get" ||
      decName === "post" ||
      decName === "put" ||
      decName === "delete" ||
      decName === "patch" ||
      decName === "api_route"
    ) {
      return "fastapi";
    }
    if (decName === "route") {
      return "flask";
    }
  }

  return hasSelf ? "method" : "function";
}
