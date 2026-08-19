// src/extractors/core/extractor.ts
//
// Language-agnostic entry point: sniff the primary language of a repo,
// dispatch to the matching per-language extractor, and return a
// SurfaceManifest. Callers do not need to know which language pack ran.
//
// M1: Python only. New languages (TypeScript, Java, .NET, Go, Rust) plug in
// by extending `LANGUAGE_DETECTORS` and adding an extractor module.

import fs from "node:fs";
import path from "node:path";
import type { SurfaceManifest, SupportedLanguage } from "./surface-manifest.js";
import { extractPythonSurface } from "../languages/python.js";
import { extractPythonSurfaceStreamed } from "../languages/python-streamed.js";
import type { SessionManager } from "../../session/session-manager.js";
import { extractTypescriptSurface } from "../languages/typescript-parse.js";
import { extractJavaSurface } from "../languages/java-parse.js";
import { extractCsharpSurface } from "../languages/csharp-parse.js";
import { extractGoSurface } from "../languages/go-parse.js";
import { extractRustSurface } from "../languages/rust-parse.js";
import { extractTypescriptSurfaceStreamed } from "../languages/typescript-streamed.js";
import { extractJavaSurfaceStreamed } from "../languages/java-streamed.js";
import { extractCsharpSurfaceStreamed } from "../languages/csharp-streamed.js";
import { extractGoSurfaceStreamed } from "../languages/go-streamed.js";
import { extractRustSurfaceStreamed } from "../languages/rust-streamed.js";

interface LanguageDetector {
  language: SupportedLanguage;
  /** Files that unambiguously identify the language when found at repo root. */
  root_markers?: string[];
  /** File extension counted across the tree — highest count wins ties. */
  extension: string;
  run: (opts: { workingDir: string }) => SurfaceManifest | Promise<SurfaceManifest>;
}

const LANGUAGE_DETECTORS: LanguageDetector[] = [
  {
    language: "python",
    root_markers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
    extension: ".py",
    run: extractPythonSurface,
  },
  {
    language: "typescript" as const,
    root_markers: ["tsconfig.json", "tsconfig.base.json"],
    extension: ".ts",
    run: extractTypescriptSurface,
  },
  {
    language: "java" as const,
    root_markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
    extension: ".java",
    run: extractJavaSurface,
  },
  {
    language: "csharp" as const,
    root_markers: [],
    extension: ".cs",
    run: extractCsharpSurface,
  },
  {
    language: "go" as const,
    root_markers: ["go.mod"],
    extension: ".go",
    run: extractGoSurface,
  },
  {
    language: "rust" as const,
    root_markers: ["Cargo.toml"],
    extension: ".rs",
    run: extractRustSurface,
  },
];

export interface ExtractOptions {
  workingDir: string;
  /** Override auto-detection when the caller already knows the language. */
  language?: SupportedLanguage;
}

export async function extractSurface(opts: ExtractOptions): Promise<SurfaceManifest> {
  const workingDir = path.resolve(opts.workingDir);
  const language = opts.language ?? detectLanguage(workingDir);
  const detector = LANGUAGE_DETECTORS.find((d) => d.language === language);
  if (!detector) {
    throw new Error(
      `Synapse v2 does not yet support ${language}. Supported: ${LANGUAGE_DETECTORS.map((d) => d.language).join(", ")}`,
    );
  }
  return await detector.run({ workingDir });
}

// -----------------------------------------------------------------------------
// Streaming variant — prefilter + checkpointed extraction.
// Uses the SessionManager to record every parsed file so Ctrl-C, the
// 15-minute soft cap, and network drops all resume without re-work.
// -----------------------------------------------------------------------------

export interface ExtractStreamedOptions {
  workingDir: string;
  session: SessionManager;
  language?: SupportedLanguage;
  captureFunctions?: boolean;
}

export async function extractSurfaceStreamed(
  opts: ExtractStreamedOptions,
): Promise<SurfaceManifest> {
  const workingDir = path.resolve(opts.workingDir);
  const language = opts.language ?? detectLanguage(workingDir);
  if (language !== "python") {
    const streamedMap: Partial<Record<string, (o: { workingDir: string; session: SessionManager; captureFunctions?: boolean }) => Promise<SurfaceManifest>>> = {
      typescript: extractTypescriptSurfaceStreamed,
      java: extractJavaSurfaceStreamed,
      csharp: extractCsharpSurfaceStreamed,
      go: extractGoSurfaceStreamed,
      rust: extractRustSurfaceStreamed,
    };
    const fn = streamedMap[language];
    if (fn) {
      return fn({ workingDir, session: opts.session, captureFunctions: opts.captureFunctions });
    }
    const detector = LANGUAGE_DETECTORS.find((d) => d.language === language);
    if (!detector) {
      throw new Error(`Synapse v2 does not yet support ${language}.`);
    }
    return detector.run({ workingDir });
  }
  return await extractPythonSurfaceStreamed({
    workingDir,
    session: opts.session,
    captureFunctions: opts.captureFunctions,
  });
}

// -----------------------------------------------------------------------------
// Language detection — root markers first, extension count as tiebreak
// -----------------------------------------------------------------------------

function detectLanguage(workingDir: string): SupportedLanguage {
  for (const d of LANGUAGE_DETECTORS) {
    if (!d.root_markers) continue;
    if (d.root_markers.some((m) => fs.existsSync(path.join(workingDir, m)))) {
      return d.language;
    }
  }

  // Fallback: extension prevalence across a shallow scan.
  const counts = new Map<SupportedLanguage, number>();
  countExtensions(workingDir, workingDir, counts, /*budget*/ 2000);
  let best: [SupportedLanguage, number] | null = null;
  for (const entry of counts) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  if (best) return best[0];

  throw new Error(
    `Could not detect a supported language in ${workingDir}. Supported: ${LANGUAGE_DETECTORS.map((d) => d.language).join(", ")}`,
  );
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build",
  "__pycache__", ".synapse", "target", "bin", "obj",
]);

function countExtensions(
  dir: string,
  root: string,
  counts: Map<SupportedLanguage, number>,
  budget: number,
): number {
  if (budget <= 0) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return budget;
  }
  for (const entry of entries) {
    if (budget <= 0) return 0;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      budget = countExtensions(full, root, counts, budget);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      const lang = LANGUAGE_DETECTORS.find((d) => d.extension === ext);
      if (lang) {
        counts.set(lang.language, (counts.get(lang.language) ?? 0) + 1);
      }
      budget -= 1;
    }
  }
  return budget;
}
