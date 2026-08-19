// tests/unit/extractors/multi-lang-parsers.test.ts
//
// End-to-end parser tests for the multi-language HTTP endpoint extractors.
// Each test loads a real fixture file and asserts the exact endpoints found —
// method, path, and suggested_tool_name — with no gaps or extras.
//
// Fixtures: tests/fixtures/multi-lang-apis/<lang>/
// If a fixture produces the wrong count, fix the parser, not the expectation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { parseJavaFile }       from "../../../src/extractors/languages/java-parse.js";
import { parseRustFile }       from "../../../src/extractors/languages/rust-parse.js";
import { parseGoFile }         from "../../../src/extractors/languages/go-parse.js";
import { parseCsharpFile }     from "../../../src/extractors/languages/csharp-parse.js";
import { parseTypescriptFile } from "../../../src/extractors/languages/typescript-parse.js";

const FIXTURES = resolve(import.meta.dirname ?? __dirname, "../../fixtures/multi-lang-apis");

function fixture(lang: string, file: string): string {
  return readFileSync(resolve(FIXTURES, lang, file), "utf-8");
}

// ---------------------------------------------------------------------------
// Java — Spring Boot (UserController.java)
// ---------------------------------------------------------------------------
describe("Java extractor — Spring Boot", () => {
  const source = fixture("java", "UserController.java");
  const result = parseJavaFile({ source, relPath: "UserController.java", module: "com.example" });

  it("parses without error", () => {
    expect(result.parseOk).toBe(true);
  });

  it("finds exactly 5 endpoints", () => {
    expect(result.endpoints).toHaveLength(5);
  });

  it("detects spring framework", () => {
    expect(result.frameworkHits).toContain("spring");
  });

  it("includes all expected routes with correct methods and paths", () => {
    const eps = result.endpoints.map(e => `${e.method} ${e.path}`);
    expect(eps).toContain("GET /api/v1/users");
    expect(eps).toContain("GET /api/v1/users/{id}");
    expect(eps).toContain("POST /api/v1/users");
    expect(eps).toContain("PUT /api/v1/users/{id}");
    expect(eps).toContain("DELETE /api/v1/users/{id}");
  });

  it("uses meaningful handler names as tool names", () => {
    const names = result.endpoints.map(e => e.suggested_tool_name);
    expect(names).toContain("getAllUsers");
    expect(names).toContain("getUserById");
    expect(names).toContain("createUser");
  });
});

// ---------------------------------------------------------------------------
// Rust — Actix-web (main.rs)
// ---------------------------------------------------------------------------
describe("Rust extractor — Actix-web", () => {
  const source = fixture("rust", "main.rs");
  const result = parseRustFile({ source, relPath: "main.rs", module: "main" });

  it("parses without error", () => {
    expect(result.parseOk).toBe(true);
  });

  it("finds exactly 5 endpoints", () => {
    expect(result.endpoints).toHaveLength(5);
  });

  it("detects actix framework", () => {
    expect(result.frameworkHits).toContain("actix");
  });

  it("includes all expected routes", () => {
    const eps = result.endpoints.map(e => `${e.method} ${e.path}`);
    expect(eps).toContain("GET /products");
    expect(eps).toContain("GET /products/{id}");
    expect(eps).toContain("POST /products");
    expect(eps).toContain("PATCH /products/{id}");
    expect(eps).toContain("DELETE /products/{id}");
  });

  it("uses fn names as tool names", () => {
    const names = result.endpoints.map(e => e.suggested_tool_name);
    expect(names).toContain("list_products");
    expect(names).toContain("get_product");
    expect(names).toContain("create_product");
  });
});

// ---------------------------------------------------------------------------
// Go — Gin (main.go)
// ---------------------------------------------------------------------------
describe("Go extractor — Gin", () => {
  const source = fixture("go", "main.go");
  const result = parseGoFile({ source, relPath: "main.go", module: "main" });

  it("parses without error", () => {
    expect(result.parseOk).toBe(true);
  });

  it("finds exactly 5 endpoints", () => {
    expect(result.endpoints).toHaveLength(5);
  });

  it("detects gin framework", () => {
    expect(result.frameworkHits).toContain("gin");
  });

  it("includes all expected routes", () => {
    const eps = result.endpoints.map(e => `${e.method} ${e.path}`);
    expect(eps).toContain("GET /orders");
    expect(eps).toContain("GET /orders/:id");
    expect(eps).toContain("POST /orders");
    expect(eps).toContain("PUT /orders/:id");
    expect(eps).toContain("DELETE /orders/:id");
  });

  it("all endpoints have file_path and start_line populated", () => {
    for (const ep of result.endpoints) {
      expect(ep.file_path).toBeTruthy();
      expect(ep.start_line).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// C# — ASP.NET Core (InvoiceController.cs)
// ---------------------------------------------------------------------------
describe("C# extractor — ASP.NET Core", () => {
  const source = fixture("csharp", "InvoiceController.cs");
  const result = parseCsharpFile({ source, relPath: "InvoiceController.cs", module: "InvoiceApi" });

  it("parses without error", () => {
    expect(result.parseOk).toBe(true);
  });

  it("finds exactly 5 endpoints", () => {
    expect(result.endpoints).toHaveLength(5);
  });

  it("resolves [Route(\"api/[controller]\")] prefix correctly", () => {
    for (const ep of result.endpoints) {
      expect(ep.path.startsWith("/api/invoice")).toBe(true);
    }
  });

  it("includes all expected routes", () => {
    const eps = result.endpoints.map(e => `${e.method} ${e.path}`);
    expect(eps).toContain("GET /api/invoice");
    expect(eps).toContain("GET /api/invoice/{id}");
    expect(eps).toContain("POST /api/invoice");
    expect(eps).toContain("PUT /api/invoice/{id}");
    expect(eps).toContain("DELETE /api/invoice/{id}");
  });
});

// ---------------------------------------------------------------------------
// TypeScript — Express (routes.ts)
// ---------------------------------------------------------------------------
describe("TypeScript extractor — Express", () => {
  const source = fixture("typescript", "routes.ts");
  const result = parseTypescriptFile({ source, relPath: "routes.ts", module: "routes" });

  it("parses without error", () => {
    expect(result.parseOk).toBe(true);
  });

  it("finds exactly 5 endpoints", () => {
    expect(result.endpoints).toHaveLength(5);
  });

  it("detects express framework", () => {
    expect(result.frameworkHits).toContain("express");
  });

  it("includes all expected routes", () => {
    const eps = result.endpoints.map(e => `${e.method} ${e.path}`);
    expect(eps).toContain("GET /tasks");
    expect(eps).toContain("GET /tasks/:id");
    expect(eps).toContain("POST /tasks");
    expect(eps).toContain("PUT /tasks/:id");
    expect(eps).toContain("DELETE /tasks/:id");
  });

  it("all endpoints have file_path and start_line for smart-names pass", () => {
    for (const ep of result.endpoints) {
      expect(ep.file_path).toBeTruthy();
      expect(ep.start_line).toBeGreaterThan(0);
      expect(ep.end_line).toBeGreaterThanOrEqual(ep.start_line);
    }
  });
});
