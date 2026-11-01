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
import { countLines } from "../utils/lines.js";

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
  // Build output and vendored third-party code in Go, Java, Rust, C# and PHP
  // repos. Their source would otherwise be counted as the user's (SYN-274).
  "target",
  "vendor",
  "obj",
];

/**
 * Source files analyze counts, by extension, for the languages Synapse can
 * build (the same set as the v2 extractors). Python files are also parsed for
 * classes and functions; the others are counted by files and lines only.
 * Without this, analyze reported 0 files and 0 lines for any repo that is not
 * Python (SYN-274).
 */
export const SUPPORTED_SOURCE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".py": "Python",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".java": "Java",
  ".cs": "C#",
  ".go": "Go",
  ".rs": "Rust",
};

/**
 * Source files in languages Synapse does not support yet. They are not
 * counted or charged, but analyze names them so a repo in one of these
 * languages does not silently report 0 files.
 */
export const UNSUPPORTED_SOURCE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".php": "PHP",
  ".rb": "Ruby",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".scala": "Scala",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C/C++",
  ".cc": "C++",
  ".cpp": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".m": "Objective-C",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".dart": "Dart",
  ".lua": "Lua",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResults {
  treeStructure: string;
  directories: string[];
  /** Files with a registered structural parser (currently .py). */
  pythonFiles: string[];
  /** Every file in a supported language, parsed or not (see SUPPORTED_SOURCE_EXTENSIONS). */
  sourceFiles: string[];
  /** File count per supported language, e.g. { Go: 12, Python: 1 }. */
  languages: Record<string, number>;
  /** File count per language Synapse does not support yet, e.g. { PHP: 40 }. */
  unsupportedLanguages: Record<string, number>;
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
  /** File count per supported language (SYN-274). */
  languages: Record<string, number>;
  /** File count per language found but not supported yet (SYN-274). */
  unsupported_languages: Record<string, number>;
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
  const sourceFiles: string[] = [];
  const languages: Record<string, number> = {};
  const unsupportedLanguages: Record<string, number> = {};
  const treeLines: string[] = [];
  const supportedExts = getSupportedExtensions();

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
        if (supportedExts.includes(ext)) {
          pythonFiles.push(relPath);
        }
        const language = SUPPORTED_SOURCE_EXTENSIONS[ext];
        if (language) {
          sourceFiles.push(relPath);
          languages[language] = (languages[language] ?? 0) + 1;
        } else if (!supportedExts.includes(ext)) {
          const other = UNSUPPORTED_SOURCE_EXTENSIONS[ext];
          if (other) unsupportedLanguages[other] = (unsupportedLanguages[other] ?? 0) + 1;
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
    sourceFiles,
    languages,
    unsupportedLanguages,
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

  // Count total lines across every supported source file, parsed or not
  // (SYN-274). Same measure as the v2 extractor's lines_scanned, since both
  // feed one quota baseline (SYN-315).
  let totalLines = 0;
  for (const relFile of scanResults.sourceFiles) {
    try {
      const content = fs.readFileSync(path.join(scanResults.rootDir, relFile), "utf-8");
      totalLines += countLines(content);
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
    file_count: scanResults.sourceFiles.length,
    total_lines_analyzed: totalLines,
    module_count: nonEmptyModules.length,
    class_count: totalClasses,
    function_count: totalFunctions,
    method_count: totalMethods,
    total_callable_count: totalFunctions + totalMethods,
    languages: scanResults.languages,
    unsupported_languages: scanResults.unsupportedLanguages,
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
