// src/parsers/python/chunk-extractor.ts
//
// Port of Python's `extract_chunks` from `code_indexer.py`.
// Uses tree-sitter to walk the AST and extract function/class chunks.

import type TreeSitter from "tree-sitter";
import type { ChunkInfo } from "../types.js";
import {
  extractSignature,
  getChildByFieldName,
  getNodeText,
} from "./ast-utils.js";
import path from "node:path";

/**
 * Recursively walk a tree-sitter AST and extract function/class chunks.
 */
export function extractChunks(
  rootNode: TreeSitter.SyntaxNode,
  source: string,
  filePath: string,
): ChunkInfo[] {
  const chunks: ChunkInfo[] = [];
  const fileName = path.basename(filePath);

  function walk(node: TreeSitter.SyntaxNode): void {
    if (node.type === "function_definition") {
      const nameNode = getChildByFieldName(node, "name");
      chunks.push({
        filePath,
        fileName,
        type: "function",
        name: nameNode ? getNodeText(nameNode, source) : "unknown",
        signature: extractSignature(node, source),
        code: getNodeText(node, source),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    } else if (node.type === "class_definition") {
      const nameNode = getChildByFieldName(node, "name");
      chunks.push({
        filePath,
        fileName,
        type: "class",
        name: nameNode ? getNodeText(nameNode, source) : "unknown",
        signature: extractSignature(node, source),
        code: getNodeText(node, source),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!);
    }
  }

  walk(rootNode);
  return chunks;
}
