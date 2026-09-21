// tests/unit/session/surface-cache.test.ts
//
// Verifies the cross-invocation discovery cache: read/write round-trip,
// repo-hash invalidation, manifest reconstruction, resume-map reshaping,
// and merging fresh ledger scans with carried-over unchanged files.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSurfaceCache,
  cacheToManifest,
  cacheToResumeScanned,
  readSurfaceCache,
  writeSurfaceCache,
  type SurfaceCacheFile,
} from "../../../src/session/surface-cache.js";
import type { LedgerRecord } from "../../../src/session/ledger.js";
import type { HttpEndpoint, SurfaceFunction } from "../../../src/extractors/core/surface-manifest.js";

function endpoint(overrides: Partial<HttpEndpoint> = {}): HttpEndpoint {
  return {
    method: "GET",
    path: "/orders",
    handler_module: "app.routes.orders",
    handler_qualname: "list_orders",
    description: "",
    payload_example: null,
    headers_hint: [],
    suggested_tool_name: "list_orders",
    file_path: "app/routes.py",
    start_line: 1,
    end_line: 5,
    ...overrides,
  };
}

function fn(overrides: Partial<SurfaceFunction> = {}): SurfaceFunction {
  return {
    module: "app.services",
    qualname: "do_thing",
    signature: "def do_thing():",
    docstring: "",
    is_async: false,
    is_public: true,
    file_path: "app/services.py",
    start_line: 1,
    end_line: 3,
    ...overrides,
  };
}

describe("surface-cache", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-surface-cache-"));
  });

  afterEach(() => {
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  it("returns null when no cache file exists", () => {
    expect(readSurfaceCache(workingDir, "repo123")).toBeNull();
  });

  it("round-trips a written cache", () => {
    const cache: SurfaceCacheFile = {
      repo_hash: "repo123",
      language: "python",
      framework: "fastapi",
      package_import_root: "app",
      captured_functions: true,
      files: {
        "app/routes.py": { sha: "abc", endpoints: [endpoint()], functions: [] },
      },
      updated_at: 1000,
    };
    writeSurfaceCache(workingDir, cache);
    const read = readSurfaceCache(workingDir, "repo123");
    expect(read).toEqual(cache);
  });

  it("invalidates the cache when repo_hash doesn't match", () => {
    const cache: SurfaceCacheFile = {
      repo_hash: "repo123",
      language: "python",
      framework: null,
      package_import_root: "app",
      captured_functions: false,
      files: {},
      updated_at: 1000,
    };
    writeSurfaceCache(workingDir, cache);
    expect(readSurfaceCache(workingDir, "different-repo")).toBeNull();
  });

  it("returns null on a corrupt cache file instead of throwing", () => {
    fs.mkdirSync(path.join(workingDir, ".synapse"), { recursive: true });
    fs.writeFileSync(path.join(workingDir, ".synapse", "surface_cache.json"), "{not json", "utf-8");
    expect(() => readSurfaceCache(workingDir, "repo123")).not.toThrow();
    expect(readSurfaceCache(workingDir, "repo123")).toBeNull();
  });

  it("cacheToManifest flattens all file entries into one manifest", () => {
    const cache: SurfaceCacheFile = {
      repo_hash: "repo123",
      language: "python",
      framework: "flask",
      package_import_root: "app",
      captured_functions: true,
      files: {
        "a.py": { sha: "sha-a", endpoints: [endpoint({ path: "/a" })], functions: [fn({ qualname: "a_fn" })] },
        "b.py": { sha: "sha-b", endpoints: [endpoint({ path: "/b" })], functions: [] },
      },
      updated_at: 1000,
    };
    const manifest = cacheToManifest(cache);
    expect(manifest.language).toBe("python");
    expect(manifest.framework).toBe("flask");
    expect(manifest.endpoints.map((e) => e.path).sort()).toEqual(["/a", "/b"]);
    expect(manifest.functions.map((f) => f.qualname)).toEqual(["a_fn"]);
  });

  it("cacheToResumeScanned reshapes files into file_scanned-like records keyed by path", () => {
    const cache: SurfaceCacheFile = {
      repo_hash: "repo123",
      language: "python",
      framework: null,
      package_import_root: "app",
      captured_functions: true,
      files: {
        "a.py": { sha: "sha-a", endpoints: [endpoint()], functions: [fn()] },
      },
      updated_at: 5000,
    };
    const scanned = cacheToResumeScanned(cache);
    const record = scanned.get("a.py");
    expect(record).toBeDefined();
    expect(record?.type).toBe("file_scanned");
    expect(record?.sha).toBe("sha-a");
    expect(record?.endpoints).toEqual([endpoint()]);
    expect(record?.functions).toEqual([fn()]);
  });

  it("buildSurfaceCache carries over unchanged files and applies fresh ledger scans", () => {
    const previous: SurfaceCacheFile = {
      repo_hash: "repo123",
      language: "python",
      framework: "fastapi",
      package_import_root: "app",
      captured_functions: false,
      files: {
        "unchanged.py": { sha: "sha-unchanged", endpoints: [endpoint({ path: "/unchanged" })], functions: [] },
        "changed.py": { sha: "old-sha", endpoints: [endpoint({ path: "/old" })], functions: [] },
      },
      updated_at: 1000,
    };

    const ledgerRecords: LedgerRecord[] = [
      {
        type: "file_scanned",
        path: "changed.py",
        sha: "new-sha",
        endpoints: [endpoint({ path: "/new" })],
        functions: [],
        scanned_at: 2000,
        elapsed_ms: 5,
      },
    ];

    const next = buildSurfaceCache({
      repoHash: "repo123",
      manifest: {
        language: "python",
        framework: "fastapi",
        endpoints: [],
        functions: [],
        package_import_root: "app",
      },
      ledgerRecords,
      previous,
      captureFunctions: false,
    });

    expect(next.files["unchanged.py"]).toEqual(previous.files["unchanged.py"]);
    expect(next.files["changed.py"].sha).toBe("new-sha");
    expect(next.files["changed.py"].endpoints[0].path).toBe("/new");
    expect(next.repo_hash).toBe("repo123");
    expect(next.captured_functions).toBe(false);
  });

  it("buildSurfaceCache works with no previous cache (first-ever discovery)", () => {
    const ledgerRecords: LedgerRecord[] = [
      {
        type: "file_scanned",
        path: "a.py",
        sha: "sha-a",
        endpoints: [endpoint()],
        functions: [fn()],
        scanned_at: 1,
        elapsed_ms: 1,
      },
    ];
    const next = buildSurfaceCache({
      repoHash: "repo123",
      manifest: {
        language: "python",
        framework: null,
        endpoints: [],
        functions: [],
        package_import_root: "app",
      },
      ledgerRecords,
      previous: null,
      captureFunctions: true,
    });
    expect(Object.keys(next.files)).toEqual(["a.py"]);
    expect(next.captured_functions).toBe(true);
  });
});
