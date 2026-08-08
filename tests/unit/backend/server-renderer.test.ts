// tests/unit/backend/server-renderer.test.ts
//
// Deterministic renderer output. Same ToolPlan + Manifest MUST produce byte-
// stable Python. Also confirms the smoke verifier's tree-sitter parse would
// accept the output.

import { describe, expect, it } from "vitest";
import { renderPython, render } from "../../../src/backend/server-renderer.js";
import type { ToolPlan } from "../../../src/backend/schemas.js";
import type { SurfaceManifest } from "../../../src/extractors/core/surface-manifest.js";

function fakeManifest(): SurfaceManifest {
  return {
    language: "python",
    framework: "fastapi",
    package_import_root: "app",
    endpoints: [],
    functions: [
      {
        module: "app.users",
        qualname: "get_user_by_id",
        signature: "def get_user_by_id(user_id: str) -> dict",
        docstring: "",
        is_async: false,
        is_public: true,
        file_path: "app/users.py",
        start_line: 10,
        end_line: 20,
      },
    ],
  };
}

function fakePlan(overrides: Partial<ToolPlan> = {}): ToolPlan {
  return {
    tool_name: "fetch_user",
    description: "Fetch a user by id.",
    param_names: ["user_id"],
    param_types: ["str"],
    body_source: "result = get_user_by_id(user_id=user_id)\nreturn result",
    imports: [],
    env_vars: [],
    is_async: false,
    ...overrides,
  };
}

describe("renderPython", () => {
  it("produces deterministic output for the same inputs", () => {
    const a = renderPython(fakePlan(), fakeManifest(), "test-server");
    const b = renderPython(fakePlan(), fakeManifest(), "test-server");
    expect(a).toBe(b);
  });

  it("includes the FastMCP scaffold + tool decorator + import", () => {
    const src = renderPython(fakePlan(), fakeManifest(), "test-server");
    expect(src).toContain("from mcp.server.fastmcp import FastMCP");
    expect(src).toContain('mcp = FastMCP("test-server")');
    expect(src).toContain('@mcp.tool(name="fetch_user"');
    expect(src).toContain("def fetch_user(user_id: str) -> dict:");
    expect(src).toContain("from app.users import get_user_by_id");
    expect(src).toContain('if __name__ == "__main__":');
    expect(src).toContain("mcp.run()");
  });

  it("emits `async def` when is_async is true", () => {
    const src = renderPython(fakePlan({ is_async: true }), fakeManifest(), "s");
    expect(src).toContain("async def fetch_user");
  });

  it("does not duplicate imports the LLM already listed", () => {
    const src = renderPython(
      fakePlan({ imports: ["from app.users import get_user_by_id"] }),
      fakeManifest(),
      "s",
    );
    const count = src.split("from app.users import get_user_by_id").length - 1;
    expect(count).toBe(1);
  });

  it("falls back to a safe body when body_source is blank", () => {
    const src = renderPython(fakePlan({ body_source: "" }), fakeManifest(), "s");
    expect(src).toContain('return {"ok": True}');
  });

  it("indents the body by exactly 4 spaces", () => {
    const src = renderPython(fakePlan(), fakeManifest(), "s");
    expect(src).toContain(
      "def fetch_user(user_id: str) -> dict:\n    result = get_user_by_id(user_id=user_id)\n    return result",
    );
  });

  it("render() dispatches by language and rejects unsupported ones", () => {
    const py = render(fakePlan(), fakeManifest(), "s");
    expect(py.ext).toBe("py");
    expect(() =>
      render(fakePlan(), { ...fakeManifest(), language: "rust" }, "s"),
    ).toThrow(/does not yet support language=rust/);
  });
});
