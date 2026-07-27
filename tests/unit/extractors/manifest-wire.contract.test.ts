// tests/unit/extractors/manifest-wire.contract.test.ts
//
// Wire-manifest contract test.
//
// Every required field on the backend Pydantic model MUST appear on the wire
// output produced by serializeManifestForWire. When the two drift (which is
// what caused the "17 validation errors: end_line missing" incident), this
// test fails loudly BEFORE the code hits prod.
//
// The list of required fields below is the single source of truth on the CLI
// side and is mirrored in the backend at
// synapse-cli-backend/synapse_backend/services/surface_manifest.py.
//
// If you add / remove a required field on the backend, update BOTH:
//   1. The Pydantic model
//   2. This test's REQUIRED_* arrays
// and CI will keep them in sync.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SurfaceManifest } from "../../../src/extractors/core/surface-manifest.js";
import { serializeManifestForWire } from "../../../src/extractors/core/manifest-wire.js";

// Load the shared JSON Schema (checked in at protos/wire-manifest.schema.json).
// Both the CLI wire serializer and the backend Pydantic model conform to this.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "../../../protos/wire-manifest.schema.json");
const wireSchema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

const REQUIRED_MANIFEST_FIELDS: string[] = wireSchema.required ?? [];
const REQUIRED_FUNCTION_FIELDS: string[] =
  wireSchema.properties?.functions?.items?.required ?? [];
const REQUIRED_ENDPOINT_FIELDS: string[] =
  wireSchema.properties?.endpoints?.items?.required ?? [];

function makeManifest(): SurfaceManifest {
  return {
    language: "python",
    framework: "fastapi",
    package_import_root: "app",
    endpoints: [
      {
        method: "GET",
        path: "/x/{id}",
        handler_module: "app.routes",
        handler_qualname: "get_x",
        description: "docstring",
        payload_example: null,
        headers_hint: [],
        suggested_tool_name: "get_x",
      },
    ],
    functions: [
      {
        module: "app.services",
        qualname: "validate",
        signature: "def validate(x: str) -> bool",
        docstring: "validate the input",
        is_async: false,
        is_public: true,
        file_path: "app/services.py",
        start_line: 10,
        end_line: 20,
      },
    ],
    background_functions: [
      {
        module: "app.services",
        qualname: "internal_helper",
        signature: "def internal_helper() -> None",
        docstring: "",
        is_async: false,
        is_public: false,
        file_path: "app/services.py",
        start_line: 100,
        end_line: 105,
      },
    ],
  };
}

describe("wire manifest contract", () => {
  it("keeps every field the backend Pydantic model requires", () => {
    const wire = JSON.parse(serializeManifestForWire(makeManifest()));

    for (const key of REQUIRED_MANIFEST_FIELDS) {
      expect(wire, `top-level "${key}" missing from wire manifest`).toHaveProperty(key);
    }
    for (const key of REQUIRED_FUNCTION_FIELDS) {
      expect(
        wire.functions[0],
        `functions[].${key} missing — backend Pydantic will reject the payload`,
      ).toHaveProperty(key);
    }
    for (const key of REQUIRED_ENDPOINT_FIELDS) {
      expect(
        wire.endpoints[0],
        `endpoints[].${key} missing — backend Pydantic will reject the payload`,
      ).toHaveProperty(key);
    }
  });

  it("strips CLI-only fields that would waste wire budget", () => {
    const wire = JSON.parse(serializeManifestForWire(makeManifest()));
    expect(wire).not.toHaveProperty("background_functions");
    expect(wire).not.toHaveProperty("stats");
  });

  it("caps docstrings and signatures so a single function can't blow the wire", () => {
    const m = makeManifest();
    m.functions[0].docstring = "x".repeat(5000);
    m.functions[0].signature = "s".repeat(5000);
    m.endpoints[0].description = "d".repeat(5000);

    const wire = JSON.parse(serializeManifestForWire(m));
    expect(wire.functions[0].docstring.length).toBeLessThanOrEqual(201);
    expect(wire.functions[0].signature.length).toBeLessThanOrEqual(241);
    expect(wire.endpoints[0].description.length).toBeLessThanOrEqual(401);
  });

  it("carries optional classifier hints when present", () => {
    const m = makeManifest();
    (m.functions[0] as { score?: number; call_site_count?: number }).score = 7;
    (m.functions[0] as { call_site_count?: number }).call_site_count = 3;

    const wire = JSON.parse(serializeManifestForWire(m));
    expect(wire.functions[0].score).toBe(7);
    expect(wire.functions[0].call_site_count).toBe(3);
  });

  it("round-trips a partial manifest without losing the partial flag", () => {
    const m = { ...makeManifest(), partial: true };
    const wire = JSON.parse(serializeManifestForWire(m));
    expect(wire.partial).toBe(true);
  });
});
