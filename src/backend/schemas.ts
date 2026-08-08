// src/backend/schemas.ts
//
// Zod schemas mirroring the Pydantic models in the private Python backend.
// Also exports JSON Schemas for Anthropic tool_use.

import { z } from "zod";

// -----------------------------------------------------------------------------
// ToolPlan — emitted by shape_tool
// -----------------------------------------------------------------------------

export const ToolPlanSchema = z.object({
  tool_name: z.string(),
  description: z.string(),
  param_names: z.array(z.string()),
  param_types: z.array(z.string()),
  body_source: z.string(),
  imports: z.array(z.string()).default([]),
  env_vars: z.array(z.string()).default([]),
  is_async: z.boolean().default(false),
});

export type ToolPlan = z.infer<typeof ToolPlanSchema>;

export const TOOL_PLAN_JSON_SCHEMA = {
  type: "object" as const,
  required: [
    "tool_name",
    "description",
    "param_names",
    "param_types",
    "body_source",
  ],
  properties: {
    tool_name: { type: "string" },
    description: { type: "string" },
    param_names: { type: "array", items: { type: "string" } },
    param_types: { type: "array", items: { type: "string" } },
    body_source: { type: "string" },
    imports: { type: "array", items: { type: "string" } },
    env_vars: { type: "array", items: { type: "string" } },
    is_async: { type: "boolean" },
  },
};

export const EMIT_TOOL_PLAN_TOOL = {
  name: "emit_tool_plan",
  description:
    "Emit exactly one MCP tool composed from functions listed in the " +
    "SurfaceManifest. Every function call in body_source MUST resolve to " +
    "a manifest entry — no inline helpers, no invented functions.",
  input_schema: TOOL_PLAN_JSON_SCHEMA,
};

export function paramsSignature(plan: ToolPlan): string {
  const parts: string[] = [];
  for (let i = 0; i < plan.param_names.length; i++) {
    const name = plan.param_names[i];
    const type = plan.param_types[i] ?? "";
    parts.push(type ? `${name}: ${type}` : name);
  }
  return parts.join(", ");
}

// -----------------------------------------------------------------------------
// FunctionVerdict — emitted by candidate_classifier shards
// -----------------------------------------------------------------------------

export const BandSchema = z.enum(["HIGH", "MEDIUM", "LOW", "SKIP"]);
export type Band = z.infer<typeof BandSchema>;

export const ToolShapeSchema = z.enum([
  "action",
  "query",
  "workflow_step",
  "helper",
  "",
]);

export const FunctionVerdictSchema = z.object({
  qualname: z.string(),
  band: BandSchema,
  tool_shape: ToolShapeSchema.default(""),
  workflow_hints: z.array(z.string()).default([]),
  one_line_purpose: z.string().default(""),
});

export type FunctionVerdict = z.infer<typeof FunctionVerdictSchema>;

export const EMIT_SHARD_VERDICTS_TOOL = {
  name: "emit_shard_verdicts",
  description:
    "Emit one verdict per function in the batch. Every function passed in " +
    "MUST appear exactly once in verdicts. Skip nothing — use band=SKIP " +
    "when the function is unsuitable rather than omitting it.",
  input_schema: {
    type: "object" as const,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          required: ["qualname", "band"],
          properties: {
            qualname: { type: "string" },
            band: { type: "string", enum: ["HIGH", "MEDIUM", "LOW", "SKIP"] },
            tool_shape: {
              type: "string",
              enum: ["action", "query", "workflow_step", "helper", ""],
            },
            workflow_hints: { type: "array", items: { type: "string" } },
            one_line_purpose: { type: "string" },
          },
        },
      },
    },
  },
};

// -----------------------------------------------------------------------------
// EndpointName — emitted by emit_endpoint_names (local auto-mode)
// -----------------------------------------------------------------------------

export const EndpointNameSchema = z.object({
  index: z.number(),
  tool_name: z.string(),
  description: z.string(),
});

export type EndpointName = z.infer<typeof EndpointNameSchema>;

export const EMIT_ENDPOINT_NAMES_TOOL = {
  name: "emit_endpoint_names",
  description:
    "Emit one entry per endpoint in the batch. Every index passed in MUST " +
    "appear exactly once in names. Skip nothing.",
  input_schema: {
    type: "object" as const,
    required: ["names"],
    properties: {
      names: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "tool_name", "description"],
          properties: {
            index: { type: "integer" },
            tool_name: {
              type: "string",
              description: "snake_case identifier, e.g. cancel_order",
            },
            description: {
              type: "string",
              description:
                "One or two sentences an AI agent can use to decide when to call this tool, " +
                "written from the handler's actual behavior — not just its route path.",
            },
          },
        },
      },
    },
  },
};

// -----------------------------------------------------------------------------
// WorkflowProposal — emitted by propose_workflows
// -----------------------------------------------------------------------------

export const WorkflowProposalSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  functions: z.array(z.string()).min(2),
  confidence: z.number().min(0).max(1).default(0),
});

export type WorkflowProposal = z.infer<typeof WorkflowProposalSchema>;

export const EMIT_WORKFLOW_PROPOSALS_TOOL = {
  name: "emit_workflow_proposals",
  description:
    "Emit 1-5 workflow proposals. Each proposal stitches 2+ HIGH/MEDIUM " +
    "functions from the manifest into a coherent, user-facing capability.",
  input_schema: {
    type: "object" as const,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          required: ["name", "purpose", "functions"],
          properties: {
            name: { type: "string" },
            purpose: { type: "string" },
            functions: {
              type: "array",
              minItems: 2,
              items: { type: "string" },
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
          },
        },
      },
    },
  },
};

// -----------------------------------------------------------------------------
// Repair — emitted by smoke_verifier one-shot repair
// -----------------------------------------------------------------------------

export const PatchedFileSchema = z.object({ source: z.string() });
export type PatchedFile = z.infer<typeof PatchedFileSchema>;

export const PATCHED_FILE_TOOL = {
  name: "patched_file",
  description: "Emit the complete corrected MCP server file as one string.",
  input_schema: {
    type: "object" as const,
    required: ["source"],
    properties: { source: { type: "string" } },
  },
};
