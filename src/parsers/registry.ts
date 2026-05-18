// src/parsers/registry.ts
import type { LanguageParser } from "./types.js";

const parsers = new Map<string, LanguageParser>();

export function registerParser(parser: LanguageParser): void {
  for (const ext of parser.extensions) {
    parsers.set(ext, parser);
  }
}

export function getParser(filePath: string): LanguageParser | undefined {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return parsers.get(ext);
}

export function getSupportedExtensions(): string[] {
  return Array.from(parsers.keys());
}

export function hasParser(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return parsers.has(ext);
}
