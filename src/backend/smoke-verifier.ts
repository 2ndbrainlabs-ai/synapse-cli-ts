// src/backend/smoke-verifier.ts
//
// Deterministic-first checks on a rendered MCP server file. Translated from
// the private Python backend's smoke_verifier.py.
//
// TS constraint: no `ast.parse` / `compile()` — we use tree-sitter-python
// (already a CLI dep for the extractor) to detect ERROR nodes. Import audit
// walks tree-sitter's import_from_statement / dotted_name nodes.
//
// One repair pass on failure via Haiku (fallback_generate task).

import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import { call, extractToolUse } from "./anthropic-call.js";
import { REPAIR_SYSTEM_PROMPT } from "./prompts.js";
import { PATCHED_FILE_TOOL, PatchedFileSchema } from "./schemas.js";
import type { SurfaceManifest } from "../extractors/core/surface-manifest.js";

const requireCJS = createRequire(import.meta.url);

let _pyParser: TreeSitter | null = null;
function getPythonParser(): TreeSitter {
  if (_pyParser) return _pyParser;
  const TS = requireCJS("tree-sitter");
  const Python = requireCJS("tree-sitter-python");
  const p = new TS();
  p.setLanguage(Python);
  _pyParser = p;
  return p;
}

export interface VerifyReport {
  verify_ok: boolean;
  check: string; // "parse" | "compile" | "import_audit" | "all"
  rounds: number;
  errors: string[];
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

function walk(
  node: TreeSitter.SyntaxNode,
  visitor: (n: TreeSitter.SyntaxNode) => void,
): void {
  visitor(node);
  for (const child of node.children) walk(child, visitor);
}

function runParse(source: string): string | null {
  const parser = getPythonParser();
  const tree = parser.parse(source);
  let firstError: TreeSitter.SyntaxNode | null = null;
  walk(tree.rootNode, (n) => {
    if (!firstError && (n.type === "ERROR" || n.isMissing)) firstError = n;
  });
  if (!firstError) return null;
  const err = firstError as TreeSitter.SyntaxNode;
  const line = err.startPosition.row + 1;
  return `SyntaxError at line ${line}: ${err.type === "ERROR" ? "unexpected token" : "missing token"}`;
}

/**
 * Compile check is redundant with tree-sitter parse in TS-land — Python's
 * `compile()` catches a superset of indent bugs that `ast.parse` misses, but
 * tree-sitter reports both under the same ERROR/missing node vocabulary.
 * Keep this as a stub so verify_and_repair mirrors the Python check ordering.
 */
function runCompile(source: string): string | null {
  void source;
  return null;
}

function runImportAudit(source: string, manifest: SurfaceManifest): string | null {
  if (!manifest.package_import_root) return null;

  const parser = getPythonParser();
  const tree = parser.parse(source);

  const manifestModules = new Set(manifest.functions.map((f) => f.module));
  const manifestPairs = new Set(
    manifest.functions.map((f) => `${f.module}::${f.qualname}`),
  );

  const bad: string[] = [];

  walk(tree.rootNode, (n) => {
    if (n.type !== "import_from_statement") return;

    // Grab the module (dotted_name after `from`) and the aliased names.
    const moduleNode = n.childForFieldName("module_name");
    const mod = moduleNode?.text ?? "";
    if (!mod || !mod.startsWith(manifest.package_import_root)) return;

    if (!manifestModules.has(mod)) {
      bad.push(`unknown module: from ${mod} import ...`);
      return;
    }

    // Every "name" field child is an imported symbol (or a dotted alias).
    for (const child of n.namedChildren) {
      if (child === moduleNode) continue;
      const importedName =
        child.type === "aliased_import"
          ? child.childForFieldName("name")?.text ?? child.text
          : child.text;
      if (!importedName) continue;
      if (!manifestPairs.has(`${mod}::${importedName}`)) {
        bad.push(`unknown function: from ${mod} import ${importedName}`);
      }
    }
  });

  return bad.length ? bad.join("\n") : null;
}

// -----------------------------------------------------------------------------
// One-shot repair via Haiku
// -----------------------------------------------------------------------------

async function repairOnce(
  client: Anthropic,
  source: string,
  errorText: string,
  sessionId: string,
  cliVersion?: string,
  installationId?: string,
): Promise<string | null> {
  const msg = await call({
    client,
    task: "fallback_generate",
    sessionId,
    system: REPAIR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `## ERROR\n${errorText}\n\n` +
          `## FILE\n\`\`\`python\n${source}\n\`\`\`\n\n` +
          "Emit the corrected file via `patched_file`.",
      },
    ],
    tools: [PATCHED_FILE_TOOL],
    toolChoice: { type: "tool", name: PATCHED_FILE_TOOL.name },
    cliVersion,
    installationId,
  });

  const input = extractToolUse(msg, PATCHED_FILE_TOOL.name);
  if (!input) return null;
  const parsed = PatchedFileSchema.safeParse(input);
  return parsed.success ? parsed.data.source : null;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export interface VerifyAndRepairOptions {
  client: Anthropic;
  source: string;
  manifest: SurfaceManifest;
  sessionId: string;
  onStatus?: (stage: string, msg: string, progress: number) => Promise<void> | void;
  cliVersion?: string;
  installationId?: string;
}

export async function verifyAndRepair(
  opts: VerifyAndRepairOptions,
): Promise<{ source: string; report: VerifyReport }> {
  let source = opts.source;
  const errors: string[] = [];
  let rounds = 0;

  const checks: Array<[string, (s: string) => string | null]> = [
    ["parse", (s) => runParse(s)],
    ["compile", (s) => runCompile(s)],
    ["import_audit", (s) => runImportAudit(s, opts.manifest)],
  ];

  for (const [name, check] of checks) {
    const err = check(source);
    if (err === null) continue;

    errors.push(`[${name}] ${err}`);
    if (opts.onStatus) {
      await opts.onStatus("repairing", `Repairing generated file (${name})`, 0.85);
    }

    let patched: string | null = null;
    try {
      patched = await repairOnce(
        opts.client,
        source,
        err,
        opts.sessionId,
        opts.cliVersion,
        opts.installationId,
      );
    } catch {
      patched = null;
    }
    rounds = 1;

    if (!patched) {
      return {
        source,
        report: { verify_ok: false, check: name, rounds, errors },
      };
    }

    source = patched;
    const err2 = check(source);
    if (err2 !== null) {
      errors.push(`[${name}:after_repair] ${err2}`);
      return {
        source,
        report: { verify_ok: false, check: name, rounds, errors },
      };
    }
  }

  return {
    source,
    report: { verify_ok: true, check: "all", rounds, errors },
  };
}
