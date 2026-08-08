// src/backend/tool-shaper.ts
//
// 3-attempt self-correcting shape stage. Mirrors the private Python
// backend's tool_shaper.shape_tool.
//
// On Zod validation failure OR AST-audit failure, appends the assistant's
// rejected output + a user turn instructing the model to emit a corrected
// version. Up to 3 total attempts before giving up.

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.mjs";
import { createRequire } from "node:module";
import type TreeSitter from "tree-sitter";
import { call, extractToolUse } from "./anthropic-call.js";
import { TOOL_SHAPER_SYSTEM_PROMPT } from "./prompts.js";
import {
  EMIT_TOOL_PLAN_TOOL,
  ToolPlanSchema,
  type FunctionVerdict,
  type ToolPlan,
} from "./schemas.js";
import type {
  SurfaceFunction,
  SurfaceManifest,
} from "../extractors/core/surface-manifest.js";

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

// -----------------------------------------------------------------------------
// AST audit — every Call must resolve to a manifest qualname (or a permitted
// builtin/stdlib name). No inline `def` helpers allowed inside body_source.
// -----------------------------------------------------------------------------

interface AuditIssue {
  kind: string;
  detail: string;
}

const BUILTINS_ALLOW: Set<string> = new Set([
  "print", "len", "str", "int", "float", "bool", "dict", "list", "tuple",
  "set", "range", "enumerate", "zip", "sorted", "sum", "min", "max", "any",
  "all", "isinstance", "getattr", "setattr", "hasattr", "type",
  "Exception", "ValueError", "TypeError", "KeyError", "RuntimeError",
  "os", "json", "re", "datetime", "logging",
]);

function walk(node: TreeSitter.SyntaxNode, visitor: (n: TreeSitter.SyntaxNode) => void): void {
  visitor(node);
  for (const child of node.children) walk(child, visitor);
}

function auditBody(bodySource: string, manifest: SurfaceManifest): AuditIssue[] {
  const issues: AuditIssue[] = [];

  // Wrap so tree-sitter accepts the naked body as a function.
  const indented = bodySource
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
  const wrapped = `def _synapse_wrapper():\n${indented || "    pass"}\n`;

  const parser = getPythonParser();
  const tree = parser.parse(wrapped);
  const root = tree.rootNode;

  let hasSyntaxError = false;
  walk(root, (n) => {
    if (n.type === "ERROR" || n.isMissing) hasSyntaxError = true;
  });
  if (hasSyntaxError) {
    issues.push({ kind: "syntax_error", detail: "body_source did not parse cleanly." });
    return issues;
  }

  const allowed = new Set<string>();
  for (const f of manifest.functions) allowed.add(f.qualname);

  walk(root, (n) => {
    // Inline helper: a function_definition whose name isn't the wrapper.
    if (n.type === "function_definition") {
      const nameNode = n.childForFieldName("name");
      const name = nameNode?.text;
      if (name && name !== "_synapse_wrapper") {
        issues.push({
          kind: "inline_helper",
          detail: `body_source defines an inline helper '${name}' — not permitted.`,
        });
      }
    }
    // Direct call: foo(...)
    if (n.type === "call") {
      const funcNode = n.childForFieldName("function");
      if (funcNode && funcNode.type === "identifier") {
        const id = funcNode.text;
        if (!allowed.has(id) && !BUILTINS_ALLOW.has(id)) {
          issues.push({
            kind: "unknown_callee",
            detail: `body_source calls '${id}' which is not in the SurfaceManifest.`,
          });
        }
      }
      // Attribute call: mod.foo(...) — intentionally permissive; imports are user-reviewable.
    }
  });

  return issues;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export interface ShapeToolOptions {
  client: Anthropic;
  manifest: SurfaceManifest;
  intent: string;
  selectedQualnames: string[];
  suggestedToolName: string;
  sessionId: string;
  verdicts?: FunctionVerdict[];
  onStatus?: (stage: string, msg: string, progress: number) => Promise<void> | void;
  cliVersion?: string;
  installationId?: string;
}

export async function shapeTool(opts: ShapeToolOptions): Promise<ToolPlan> {
  // Optional pre-filter using classifier verdicts.
  const bandByQual = new Map<string, string>();
  const hintsByQual = new Map<string, string[]>();
  if (opts.verdicts) {
    for (const v of opts.verdicts) {
      bandByQual.set(v.qualname, v.band);
      if (v.workflow_hints?.length) hintsByQual.set(v.qualname, v.workflow_hints);
    }
  }
  const keep = (qual: string): boolean => {
    if (bandByQual.size === 0) return true;
    const b = bandByQual.get(qual) ?? "LOW";
    return b === "HIGH" || b === "MEDIUM";
  };

  // Winnow manifest down to what the LLM needs to see.
  let candidates: SurfaceFunction[] = [];
  if (opts.selectedQualnames.length > 0) {
    const byQual = new Map(opts.manifest.functions.map((f) => [f.qualname, f]));
    for (const q of opts.selectedQualnames) {
      const f = byQual.get(q);
      if (f) candidates.push(f);
    }
  }
  if (candidates.length === 0) {
    candidates = opts.manifest.functions.filter((f) => keep(f.qualname));
  }
  if (candidates.length === 0) {
    candidates = [...opts.manifest.functions];
  }

  const manifestView = {
    language: opts.manifest.language,
    framework: opts.manifest.framework,
    package_import_root: opts.manifest.package_import_root,
    functions: candidates.map((f) => {
      const entry: Record<string, unknown> = {
        module: f.module,
        qualname: f.qualname,
        signature: f.signature,
        docstring: f.docstring,
        is_async: f.is_async,
      };
      const hints = hintsByQual.get(f.qualname);
      if (hints && hints.length > 0) entry.workflow_hints = hints;
      return entry;
    }),
  };

  const userContent =
    `## USER INTENT\n${opts.intent}\n\n` +
    `## SUGGESTED TOOL NAME (optional hint)\n${opts.suggestedToolName || "(none)"}\n\n` +
    `## SURFACE MANIFEST (functions you may call)\n` +
    "```json\n" + JSON.stringify(manifestView, null, 2) + "\n```\n\n" +
    "Emit ONE MCP tool via `emit_tool_plan` that fulfils the intent using ONLY the listed functions.";

  let messages: MessageParam[] = [{ role: "user", content: userContent }];
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.onStatus) {
      await opts.onStatus(
        "shaping",
        `Composing MCP tool (attempt ${attempt + 1})`,
        0.4 + attempt * 0.1,
      );
    }

    const msg = await call({
      client: opts.client,
      task: "generate",
      sessionId: opts.sessionId,
      system: TOOL_SHAPER_SYSTEM_PROMPT,
      messages,
      tools: [EMIT_TOOL_PLAN_TOOL],
      toolChoice: { type: "tool", name: EMIT_TOOL_PLAN_TOOL.name },
      cliVersion: opts.cliVersion,
      installationId: opts.installationId,
    });

    const toolInput = extractToolUse(msg, EMIT_TOOL_PLAN_TOOL.name);
    if (toolInput === null) {
      lastError = "Model did not emit an emit_tool_plan tool_use block.";
    } else {
      const parsed = ToolPlanSchema.safeParse(toolInput);
      if (!parsed.success) {
        lastError = `Zod validation failed:\n${parsed.error.message}`;
      } else if (parsed.data.param_names.length !== parsed.data.param_types.length) {
        lastError =
          "param_names and param_types must be parallel arrays of equal length.";
      } else {
        const issues = auditBody(parsed.data.body_source, opts.manifest);
        if (issues.length === 0) return parsed.data;
        lastError =
          "AST audit rejected the composed body:\n" +
          issues.map((i) => `- [${i.kind}] ${i.detail}`).join("\n");
      }
    }

    // Feed the failure back for the next attempt.
    messages = [
      { role: "user", content: userContent },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              toolInput === null
                ? "(no tool_use emitted)"
                : JSON.stringify(toolInput, null, 2),
          },
        ],
      },
      {
        role: "user",
        content:
          `Your previous emit_tool_plan was rejected:\n\n${lastError}\n\n` +
          "Emit a corrected emit_tool_plan tool_use. Fix ONLY the issues above; " +
          "keep everything that was correct.",
      },
    ];
  }

  throw new Error(`ToolShaper failed after 3 attempts. Last error:\n${lastError}`);
}
