// src/analyzer/codebase-analyzer.ts
//
// Scans a project directory, parses all files with registered language parsers,
// and generates a project schema (directory tree + module details) along with
// a statistics JSON object.
//
// Ported from the Python codebase_analyzer.py.

import fs from "node:fs";
import path from "node:path";
import type { ModuleInfo } from "../parsers/types.js";
import { getParser, getSupportedExtensions } from "../parsers/registry.js";

const DEFAULT_IGNORE_DIRS = [
  "__pycache__",
  ".git",
  ".synapse",
  "node_modules",
  "venv",
  "env",
  ".venv",
  "dist",
  "build",
  ".egg-info",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResults {
  treeStructure: string;
  directories: string[];
  /** Kept as pythonFiles for compatibility, though it includes all parseable files. */
  pythonFiles: string[];
  rootDir: string;
}

export interface ProjectStatistics {
  project_name: string;
  directory_count: number;
  file_count: number;
  total_lines_analyzed: number;
  module_count: number;
  class_count: number;
  function_count: number;
  method_count: number;
  total_callable_count: number;
  modules: Array<{
    name: string;
    file: string;
    classes: number;
    functions: number;
    imports: number;
  }>;
}

// ---------------------------------------------------------------------------
// scanProjectStructure
// ---------------------------------------------------------------------------

/**
 * Walk `workingDir` recursively, building a directory-tree string and
 * collecting directories + parseable files (based on registered parser
 * extensions).
 */
export function scanProjectStructure(
  workingDir: string,
  ignoreDirs?: string[],
): ScanResults {
  if (!ignoreDirs) ignoreDirs = DEFAULT_IGNORE_DIRS;

  const directories: string[] = [];
  const pythonFiles: string[] = [];
  const treeLines: string[] = [];

  const ignoreSet = new Set(ignoreDirs);

  function shouldIgnore(pathStr: string): boolean {
    const parts = pathStr.split(path.sep);
    return parts.some((p) => ignoreSet.has(p));
  }

  function buildTree(directory: string, prefix: string = ""): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then alphabetically by name
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Filter out ignored paths
    entries = entries.filter(
      (e) => !shouldIgnore(path.join(directory, e.name)),
    );

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const fullPath = path.join(directory, entry.name);
      const relPath = path.relative(workingDir, fullPath);

      if (entry.isDirectory()) {
        treeLines.push(`${prefix}${connector}${entry.name}/`);
        directories.push(relPath);
        const extension = isLast ? "    " : "│   ";
        buildTree(fullPath, prefix + extension);
      } else {
        treeLines.push(`${prefix}${connector}${entry.name}`);
        // Track files that have a registered parser (currently .py)
        const ext = path.extname(entry.name);
        const supportedExts = getSupportedExtensions();
        if (supportedExts.includes(ext)) {
          pythonFiles.push(relPath);
        }
      }
    }
  }

  const rootName = path.basename(workingDir);
  treeLines.push(`${rootName}/`);
  buildTree(workingDir);

  return {
    treeStructure: treeLines.join("\n"),
    directories,
    pythonFiles,
    rootDir: workingDir,
  };
}

// ---------------------------------------------------------------------------
// parseProjectFiles
// ---------------------------------------------------------------------------

/**
 * Parse every file in `files` (relative paths) using the appropriate
 * registered language parser, returning an array of `ModuleInfo` objects.
 */
export function parseProjectFiles(
  workingDir: string,
  files: string[],
): ModuleInfo[] {
  const modules: ModuleInfo[] = [];

  for (const relFile of files) {
    const fullPath = path.join(workingDir, relFile);
    const parser = getParser(fullPath);
    if (!parser) continue;

    try {
      const source = fs.readFileSync(fullPath, "utf-8");
      const moduleInfo = parser.parseModule(fullPath, source);
      modules.push(moduleInfo);
    } catch {
      // Return an empty module on parse failure
      modules.push({
        filePath: fullPath,
        moduleName: path.basename(fullPath, path.extname(fullPath)),
        imports: [],
        classes: [],
        functions: [],
      });
    }
  }

  return modules;
}

// ---------------------------------------------------------------------------
// generateProjectSchema
// ---------------------------------------------------------------------------

/**
 * Build a human-readable project schema string from scan results and parsed
 * module information. This includes the directory tree followed by detailed
 * per-module breakdowns of imports, classes, and functions.
 */
export function generateProjectSchema(
  scanResults: ScanResults,
  modules: ModuleInfo[],
): string {
  const lines: string[] = [];

  lines.push("=".repeat(80));
  lines.push("PROJECT SCHEMA");
  lines.push("=".repeat(80));
  lines.push("");
  lines.push("DIRECTORY STRUCTURE:");
  lines.push("-".repeat(80));
  lines.push(scanResults.treeStructure);
  lines.push("");
  lines.push("=".repeat(80));
  lines.push("MODULE DETAILS:");
  lines.push("=".repeat(80));
  lines.push("");

  for (const mod of modules) {
    if (mod.classes.length === 0 && mod.functions.length === 0) continue;

    lines.push(`Module: ${mod.moduleName}`);
    lines.push(`File: ${mod.filePath}`);
    lines.push("-".repeat(80));

    if (mod.imports.length > 0) {
      const shown = mod.imports.slice(0, 10);
      lines.push(`Imports: ${shown.join(", ")}`);
      if (mod.imports.length > 10) {
        lines.push(`  ... and ${mod.imports.length - 10} more`);
      }
      lines.push("");
    }

    if (mod.classes.length > 0) {
      lines.push(`Classes (${mod.classes.length}):`);
      for (const cls of mod.classes) {
        const basesStr =
          cls.bases.length > 0 ? `(${cls.bases.join(", ")})` : "";
        lines.push(`  • ${cls.name}${basesStr} [line ${cls.lineNumber}]`);
        if (cls.docstring) {
          const preview = cls.docstring.split("\n")[0].substring(0, 60);
          lines.push(`    ${preview}`);
        }
        if (cls.methods.length > 0) {
          lines.push(
            `    Methods: ${cls.methods.map((m) => m.name).join(", ")}`,
          );
        }
      }
      lines.push("");
    }

    if (mod.functions.length > 0) {
      lines.push(`Functions (${mod.functions.length}):`);
      for (const func of mod.functions) {
        const asyncPrefix = func.isAsync ? "async " : "";
        lines.push(
          `  • ${asyncPrefix}${func.name}(${func.parameters.join(", ")}) -> ${func.returnType}`,
        );
        if (func.docstring) {
          const preview = func.docstring.split("\n")[0].substring(0, 60);
          lines.push(`    ${preview}`);
        }
      }
      lines.push("");
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// generateStatisticsJson
// ---------------------------------------------------------------------------

/**
 * Produce a statistics object summarising the project: counts of directories,
 * files, classes, functions, methods, and per-module breakdowns.
 */
export function generateStatisticsJson(
  scanResults: ScanResults,
  modules: ModuleInfo[],
): ProjectStatistics {
  const totalClasses = modules.reduce((sum, m) => sum + m.classes.length, 0);
  const totalFunctions = modules.reduce(
    (sum, m) => sum + m.functions.length,
    0,
  );
  const totalMethods = modules.reduce(
    (sum, m) => sum + m.classes.reduce((s, c) => s + c.methods.length, 0),
    0,
  );

  // Count total lines across all analysed files
  let totalLines = 0;
  for (const mod of modules) {
    try {
      const content = fs.readFileSync(mod.filePath, "utf-8");
      totalLines += content.split("\n").length;
    } catch {
      /* skip unreadable files */
    }
  }

  const nonEmptyModules = modules.filter(
    (m) => m.classes.length > 0 || m.functions.length > 0,
  );

  return {
    project_name: path.basename(scanResults.rootDir),
    directory_count: scanResults.directories.length + 1, // +1 for the root
    file_count: scanResults.pythonFiles.length,
    total_lines_analyzed: totalLines,
    module_count: nonEmptyModules.length,
    class_count: totalClasses,
    function_count: totalFunctions,
    method_count: totalMethods,
    total_callable_count: totalFunctions + totalMethods,
    modules: nonEmptyModules.map((m) => ({
      name: m.moduleName,
      file: m.filePath,
      classes: m.classes.length,
      functions: m.functions.length,
      imports: m.imports.length,
    })),
  };
}

// ---------------------------------------------------------------------------
// analyzeCodebase  (main entry point)
// ---------------------------------------------------------------------------

/**
 * High-level convenience function: scan the project, parse all supported
 * files, and return the schema text together with a statistics object.
 *
 * NOTE: The parser registry must be populated before calling this function.
 * Ensure the `PythonParser` (or other parsers) have been registered via
 * `registerParser()` beforehand.
 */
export function analyzeCodebase(
  workingDir: string,
): [string, ProjectStatistics] {
  const scanResults = scanProjectStructure(workingDir);
  const modules = parseProjectFiles(workingDir, scanResults.pythonFiles);
  const schema = generateProjectSchema(scanResults, modules);
  const statistics = generateStatisticsJson(scanResults, modules);
  return [schema, statistics];
}

// ---------------------------------------------------------------------------
// saveAnalysisResults
// ---------------------------------------------------------------------------

/**
 * Persist the schema text and statistics JSON to the `.synapse` directory.
 */
export function saveAnalysisResults(
  synapseDir: string,
  schemaText: string,
  statistics: ProjectStatistics,
): void {
  fs.mkdirSync(synapseDir, { recursive: true });
  fs.writeFileSync(
    path.join(synapseDir, "project_schema.txt"),
    schemaText,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(synapseDir, "statistics.json"),
    JSON.stringify(statistics, null, 2),
    "utf-8",
  );
}
