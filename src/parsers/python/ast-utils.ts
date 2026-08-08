// src/parsers/python/ast-utils.ts
//
// Helper utilities for working with tree-sitter Python AST nodes.
//
// IMPORTANT: tree-sitter's Node.js binding reports `startIndex`/`endIndex` as
// **UTF-16 code-unit offsets** (JS string indexes), NOT UTF-8 byte offsets.
// Slicing a UTF-8 `Buffer` with these indexes shifts extracted text left by
// `utf8_bytes(non-ASCII) - utf16_units(non-ASCII)` for every multi-byte char
// that appears BEFORE the node in the file. In practice: an em-dash (3 UTF-8
// bytes, 1 UTF-16 unit) anywhere earlier in the file corrupts every function
// name after it by 2 characters. So we slice the source STRING here.

import type TreeSitter from "tree-sitter";

/**
 * Backwards-compat: accept either the raw source string or a UTF-8 Buffer.
 * Callers that still pass a Buffer are auto-decoded once per call — cheap
 * for the sizes we handle (single source files).
 */
export type SourceLike = string | Buffer;

function asString(src: SourceLike): string {
  return typeof src === "string" ? src : src.toString("utf-8");
}

/**
 * Extract the first line of a node's text as its signature.
 */
export function extractSignature(
  node: TreeSitter.SyntaxNode,
  source: SourceLike,
): string {
  const code = asString(source).slice(node.startIndex, node.endIndex);
  return code.split("\n")[0];
}

/**
 * Get the full text of a tree-sitter node.
 */
export function getNodeText(
  node: TreeSitter.SyntaxNode,
  source: SourceLike,
): string {
  return asString(source).slice(node.startIndex, node.endIndex);
}

/**
 * Convenience wrapper around `node.childForFieldName`.
 */
export function getChildByFieldName(
  node: TreeSitter.SyntaxNode,
  name: string,
): TreeSitter.SyntaxNode | null {
  return node.childForFieldName(name);
}

/**
 * Extract the simple decorator name from a `decorator` node.
 *
 * Examples:
 *   @property           → "property"
 *   @app.route("/")     → "route"
 *   @validator("field") → "validator"
 */
export function extractDecoratorName(
  node: TreeSitter.SyntaxNode,
  source: SourceLike,
): string {
  const text = getNodeText(node, source);
  // Remove @ prefix
  const expr = text.replace(/^@/, "").trim();

  // Handle calls: @validator("x") → "validator"
  const callMatch = expr.match(/^(?:[\w.]+\.)?(\w+)\s*\(/);
  if (callMatch) return callMatch[1];

  // Handle attribute: @app.route → "route"
  const attrMatch = expr.match(/\.(\w+)$/);
  if (attrMatch) return attrMatch[1];

  // Simple: @property → "property"
  const simpleMatch = expr.match(/^(\w+)$/);
  if (simpleMatch) return simpleMatch[1];

  return "";
}
