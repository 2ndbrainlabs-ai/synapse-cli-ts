// src/parsers/python/ast-utils.ts
//
// Helper utilities for working with tree-sitter Python AST nodes.

import type TreeSitter from "tree-sitter";

/**
 * Extract the first line of a node's text as its signature.
 */
export function extractSignature(
  node: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): string {
  const code = codeBytes
    .subarray(node.startIndex, node.endIndex)
    .toString("utf-8");
  return code.split("\n")[0];
}

/**
 * Get the full text of a tree-sitter node.
 */
export function getNodeText(
  node: TreeSitter.SyntaxNode,
  codeBytes: Buffer,
): string {
  return codeBytes
    .subarray(node.startIndex, node.endIndex)
    .toString("utf-8");
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
  codeBytes: Buffer,
): string {
  const text = getNodeText(node, codeBytes);
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
