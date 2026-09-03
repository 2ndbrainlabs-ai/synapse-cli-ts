// tests/unit/backend/smoke-verifier.test.ts
//
// Deterministic checks — no LLM. Verifies that runParse and runImportAudit
// (invoked implicitly via verifyAndRepair on valid input) accept known-good
// Python and flag known-bad Python.

import { describe, expect, it } from "vitest";
import { verifyAndRepair } from "../../../src/backend/smoke-verifier.js";
import type { SurfaceManifest } from "../../../src/extractors/core/surface-manifest.js";

// Fake provider — should never be invoked on a valid input. If the verifier
// tries to repair, this throws and the test fails.
const shouldNotBeCalledProvider = {
  id: "anthropic",
  label: "Never",
  modelFor: () => "never",
  send: async () => {
    throw new Error("the provider should NOT be called on valid input");
  },
} as never;

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

const validSource = `from __future__ import annotations
from mcp.server.fastmcp import FastMCP
from app.users import get_user_by_id

mcp = FastMCP("test")

@mcp.tool(name="fetch_user", description="d")
def fetch_user(user_id: str) -> dict:
    result = get_user_by_id(user_id=user_id)
    return result


if __name__ == "__main__":
    mcp.run()
`;

describe("verifyAndRepair — happy path", () => {
  it("accepts syntactically valid Python without calling anthropic", async () => {
    const { source, report } = await verifyAndRepair({
      provider: shouldNotBeCalledProvider,
      source: validSource,
      manifest: fakeManifest(),
      sessionId: "test",
    });
    expect(report.verify_ok).toBe(true);
    expect(report.check).toBe("all");
    expect(report.errors).toEqual([]);
    expect(source).toBe(validSource);
  });

  it("passes third-party imports through the audit (mcp, os, json, ...)", async () => {
    const src = validSource + "\nimport os\nimport json\nfrom typing import Optional\n";
    const { report } = await verifyAndRepair({
      provider: shouldNotBeCalledProvider,
      source: src,
      manifest: fakeManifest(),
      sessionId: "test",
    });
    expect(report.verify_ok).toBe(true);
  });

  it("passes imports from unknown packages that aren't under package_import_root", async () => {
    const src = validSource + "\nfrom requests import Session\n";
    const { report } = await verifyAndRepair({
      provider: shouldNotBeCalledProvider,
      source: src,
      manifest: fakeManifest(),
      sessionId: "test",
    });
    expect(report.verify_ok).toBe(true);
  });
});

describe("verifyAndRepair — failure path", () => {
  it("flags an import of an unknown function under package_import_root", async () => {
    // "app.users" is a known module, but no function `nonexistent_function`.
    const src = validSource.replace(
      "from app.users import get_user_by_id",
      "from app.users import nonexistent_function",
    );
    // The manifest still has get_user_by_id, so this import fails audit.
    // The verifier will try to repair; since the fake client throws, the
    // pass-through error path fires and returns a non-ok report.
    const { report } = await verifyAndRepair({
      provider: shouldNotBeCalledProvider,
      source: src,
      manifest: fakeManifest(),
      sessionId: "test",
    });
    expect(report.verify_ok).toBe(false);
    expect(report.check).toBe("import_audit");
    expect(report.errors.some((e) => e.includes("nonexistent_function"))).toBe(true);
  });

  it("flags a syntax error before running the audit", async () => {
    const broken = "def broken(:\n    return 1\n";
    const { report } = await verifyAndRepair({
      provider: shouldNotBeCalledProvider,
      source: broken,
      manifest: fakeManifest(),
      sessionId: "test",
    });
    expect(report.verify_ok).toBe(false);
    expect(report.check).toBe("parse");
  });
});
