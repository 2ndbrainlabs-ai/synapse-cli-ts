// tests/unit/backend/schemas.test.ts
//
// Sanity checks on the Zod schemas that stand in for the private Python
// backend's Pydantic models. If any of these fail, the backend has drifted.

import { describe, expect, it } from "vitest";
import {
  FunctionVerdictSchema,
  ToolPlanSchema,
  WorkflowProposalSchema,
  PatchedFileSchema,
  paramsSignature,
  EMIT_TOOL_PLAN_TOOL,
  EMIT_SHARD_VERDICTS_TOOL,
} from "../../../src/backend/schemas.js";

describe("ToolPlanSchema", () => {
  it("accepts a minimally valid plan", () => {
    const r = ToolPlanSchema.safeParse({
      tool_name: "fetch_user",
      description: "Fetches a user by id.",
      param_names: ["user_id"],
      param_types: ["str"],
      body_source: "return {'ok': True}",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.is_async).toBe(false);
      expect(r.data.imports).toEqual([]);
      expect(r.data.env_vars).toEqual([]);
    }
  });

  it("rejects a plan missing the required body_source field", () => {
    const r = ToolPlanSchema.safeParse({
      tool_name: "x",
      description: "x",
      param_names: [],
      param_types: [],
    });
    expect(r.success).toBe(false);
  });

  it("paramsSignature emits typed params", () => {
    const r = ToolPlanSchema.parse({
      tool_name: "x",
      description: "x",
      param_names: ["a", "b"],
      param_types: ["str", "int"],
      body_source: "pass",
    });
    expect(paramsSignature(r)).toBe("a: str, b: int");
  });

  it("paramsSignature omits type annotation when empty", () => {
    const r = ToolPlanSchema.parse({
      tool_name: "x",
      description: "x",
      param_names: ["a"],
      param_types: [""],
      body_source: "pass",
    });
    expect(paramsSignature(r)).toBe("a");
  });
});

describe("FunctionVerdictSchema", () => {
  it("accepts a minimal HIGH verdict", () => {
    const r = FunctionVerdictSchema.safeParse({
      qualname: "get_user",
      band: "HIGH",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid band", () => {
    const r = FunctionVerdictSchema.safeParse({
      qualname: "get_user",
      band: "EXCELLENT",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid tool_shape", () => {
    const r = FunctionVerdictSchema.safeParse({
      qualname: "get_user",
      band: "HIGH",
      tool_shape: "magical",
    });
    expect(r.success).toBe(false);
  });
});

describe("WorkflowProposalSchema", () => {
  it("requires at least 2 functions", () => {
    const r = WorkflowProposalSchema.safeParse({
      name: "flow",
      purpose: "does a thing",
      functions: ["only.one"],
      confidence: 0.9,
    });
    expect(r.success).toBe(false);
  });

  it("clamps confidence to [0,1]", () => {
    const bad = WorkflowProposalSchema.safeParse({
      name: "flow",
      purpose: "x",
      functions: ["a.b", "c.d"],
      confidence: 1.5,
    });
    expect(bad.success).toBe(false);
  });
});

describe("PatchedFileSchema", () => {
  it("accepts a repair emission", () => {
    const r = PatchedFileSchema.safeParse({ source: "print(1)\n" });
    expect(r.success).toBe(true);
  });
});

describe("Anthropic tool defs match schemas", () => {
  it("emit_tool_plan required fields align with Pydantic contract", () => {
    expect(EMIT_TOOL_PLAN_TOOL.input_schema.required).toEqual([
      "tool_name",
      "description",
      "param_names",
      "param_types",
      "body_source",
    ]);
  });

  it("emit_shard_verdicts nested band enum is exhaustive", () => {
    const verdicts = EMIT_SHARD_VERDICTS_TOOL.input_schema.properties.verdicts;
    // Force TS to see it as an unknown shape then narrow inline.
    const items = (verdicts as { items: { properties: { band: { enum: string[] } } } }).items;
    expect(items.properties.band.enum).toEqual(["HIGH", "MEDIUM", "LOW", "SKIP"]);
  });
});
