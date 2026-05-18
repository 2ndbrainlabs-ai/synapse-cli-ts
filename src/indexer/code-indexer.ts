import fs from "node:fs";
import path from "node:path";
import type { ChunkInfo } from "../parsers/types.js";
import { getParser, hasParser } from "../parsers/registry.js";
import { embedTexts, embedText } from "./embedder.js";
import { VectorStore, type ChunkRecord, type SearchResult } from "./vector-store.js";
import { loadIndexMetadata, saveIndexMetadata } from "./metadata.js";

const DEFAULT_SKIP_DIRS = new Set([
  "__pycache__", ".git", ".venv", "venv", "node_modules",
  ".synapse", "env", ".env",
]);

const MCP_CODE_PATTERNS = [
  "@server.tool()",
  "@server.resource(",
  "FastMCP(",
  "from mcp.server.fastmcp import FastMCP",
  "server.run()",
];

export function indexProject(
  rootDir: string,
  skipDirs?: Set<string>,
  verbose = false,
): ChunkInfo[] {
  if (!skipDirs) skipDirs = DEFAULT_SKIP_DIRS;
  const allChunks: ChunkInfo[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs!.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const filePath = path.join(dir, entry.name);
        const parser = getParser(filePath);
        if (!parser) continue;

        try {
          const source = fs.readFileSync(filePath);
          const chunks = parser.extractChunks(filePath, source);
          allChunks.push(...chunks);
          if (verbose) console.log(`  Indexed ${filePath}: ${chunks.length} chunks`);
        } catch (e) {
          if (verbose) console.log(`  Error parsing ${filePath}: ${e}`);
        }
      }
    }
  }

  walk(rootDir);
  return allChunks;
}

export async function storeChunks(
  chunks: ChunkInfo[],
  synapseDir: string,
  collectionName = "code_context",
): Promise<number> {
  if (chunks.length === 0) return 0;

  const dbPath = path.join(synapseDir, `${collectionName}.lance`);
  const store = await VectorStore.open(dbPath, collectionName);

  // Generate embeddings
  const texts = chunks.map(c => `${c.type} ${c.name}\n${c.code}`);
  const embeddings = await embedTexts(texts);

  // Build records
  const records: ChunkRecord[] = chunks.map((c, i) => ({
    vector: embeddings[i],
    filePath: c.filePath,
    fileName: c.fileName,
    type: c.type,
    name: c.name,
    signature: c.signature,
    code: c.code,
    startLine: c.startLine,
    endLine: c.endLine,
  }));

  // Recreate table (fresh index)
  await store.createTable(records);
  return records.length;
}

export async function searchCode(
  query: string,
  synapseDir: string,
  collectionName = "code_context",
  topK = 5,
): Promise<SearchResult[]> {
  const dbPath = path.join(synapseDir, `${collectionName}.lance`);
  const store = await VectorStore.open(dbPath, collectionName);
  if (!(await store.tableExists())) return [];

  const queryVector = await embedText(query);
  const requestLimit = topK * 3;
  const rawResults = await store.search(queryVector, requestLimit);

  // Filter out MCP server code
  const filtered: SearchResult[] = [];
  for (const r of rawResults) {
    if (MCP_CODE_PATTERNS.some(p => r.code.includes(p))) continue;
    filtered.push(r);
    if (filtered.length >= topK) break;
  }
  return filtered;
}

export async function getAllIndexedItems(
  synapseDir: string,
  collectionName = "code_context",
  limit = 100,
): Promise<ChunkRecord[]> {
  const dbPath = path.join(synapseDir, `${collectionName}.lance`);
  const store = await VectorStore.open(dbPath, collectionName);
  if (!(await store.tableExists())) return [];

  const items = await store.getAllItems(limit);
  return items.filter(item => !MCP_CODE_PATTERNS.some(p => item.code.includes(p)));
}

export interface SyncStats {
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

export async function syncIndex(
  rootDir: string,
  synapseDir: string,
  collectionName = "code_context",
  skipPatterns?: Set<string>,
  skipDirs?: Set<string>,
  verbose = false,
): Promise<SyncStats> {
  if (!skipPatterns) skipPatterns = new Set(["mcp_server.py"]);
  if (!skipDirs) skipDirs = DEFAULT_SKIP_DIRS;

  const metadata = loadIndexMetadata(synapseDir);
  const currentFiles = new Set<string>();
  const filesToUpdate: string[] = [];

  // Walk and find modified/new files
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs!.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && hasParser(entry.name)) {
        if (skipPatterns!.has(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        currentFiles.add(filePath);

        try {
          const mtime = fs.statSync(filePath).mtimeMs / 1000;
          const lastIndexed = metadata[filePath] ?? 0;
          if (mtime > lastIndexed) filesToUpdate.push(filePath);
        } catch {
          /* skip unreadable files */
        }
      }
    }
  }

  walk(rootDir);

  const deletedFiles = new Set(
    Object.keys(metadata).filter(f => !currentFiles.has(f)),
  );

  const stats: SyncStats = {
    added: 0,
    updated: 0,
    deleted: 0,
    unchanged: currentFiles.size - filesToUpdate.length,
  };

  if (filesToUpdate.length === 0 && deletedFiles.size === 0) return stats;

  const dbPath = path.join(synapseDir, `${collectionName}.lance`);
  const store = await VectorStore.open(dbPath, collectionName);

  // Update modified/new files
  for (const filePath of filesToUpdate) {
    const wasIndexed = filePath in metadata;
    try {
      // Delete old vectors for this file
      await store.deleteByFilePath(filePath);

      // Parse and embed
      const parser = getParser(filePath);
      if (!parser) continue;
      const source = fs.readFileSync(filePath);
      const chunks = parser.extractChunks(filePath, source);
      if (chunks.length === 0) continue;

      const texts = chunks.map(c => `${c.type} ${c.name}\n${c.code}`);
      const embeddings = await embedTexts(texts);
      const records: ChunkRecord[] = chunks.map((c, i) => ({
        vector: embeddings[i],
        filePath: c.filePath,
        fileName: c.fileName,
        type: c.type,
        name: c.name,
        signature: c.signature,
        code: c.code,
        startLine: c.startLine,
        endLine: c.endLine,
      }));

      await store.upsert(records);
      metadata[filePath] = Date.now() / 1000;
      stats[wasIndexed ? "updated" : "added"]++;
    } catch (e) {
      if (verbose) console.log(`  Error indexing ${filePath}: ${e}`);
    }
  }

  // Remove deleted files
  for (const filePath of deletedFiles) {
    try {
      await store.deleteByFilePath(filePath);
      delete metadata[filePath];
      stats.deleted++;
    } catch (e) {
      if (verbose) console.log(`  Error removing ${filePath}: ${e}`);
    }
  }

  saveIndexMetadata(synapseDir, metadata);
  return stats;
}
