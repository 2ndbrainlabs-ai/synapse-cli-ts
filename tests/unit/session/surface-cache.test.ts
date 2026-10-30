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
  isCacheUsable,
  readSurfaceCache,
  SURFACE_CACHE_VERSION,
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
      version: SURFACE_CACHE_VERSION,
      repo_hash: "repo123",
      language: "python",
      framework: "fastapi",
      package_import_root: "app",
      captured_functions: true,
      files: {
        "app/routes.py": { sha: "abc", endpoints: [endpoint()], functions: [] },
      },
      lines_scanned: 100,
      updated_at: 1000,
    };
    writeSurfaceCache(workingDir, cache);
    const read = readSurfaceCache(workingDir, "repo123");
    expect(read).toEqual(cache);
  });

  it("invalidates the cache when repo_hash doesn't match", () => {
    const cache: SurfaceCacheFile = {
      version: SURFACE_CACHE_VERSION,
      repo_hash: "repo123",
      language: "python",
      framework: null,
      package_import_root: "app",
      captured_functions: false,
      files: {},
      lines_scanned: 100,
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
      version: SURFACE_CACHE_VERSION,
      repo_hash: "repo123",
      language: "python",
      framework: "flask",
      package_import_root: "app",
      captured_functions: true,
      files: {
        "a.py": { sha: "sha-a", endpoints: [endpoint({ path: "/a" })], functions: [fn({ qualname: "a_fn" })] },
        "b.py": { sha: "sha-b", endpoints: [endpoint({ path: "/b" })], functions: [] },
      },
      lines_scanned: 100,
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
      version: SURFACE_CACHE_VERSION,
      repo_hash: "repo123",
      language: "python",
      framework: null,
      package_import_root: "app",
      captured_functions: true,
      files: {
        "a.py": { sha: "sha-a", endpoints: [endpoint()], functions: [fn()] },
      },
      lines_scanned: 100,
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
      version: SURFACE_CACHE_VERSION,
      repo_hash: "repo123",
      language: "python",
      framework: "fastapi",
      package_import_root: "app",
      captured_functions: false,
      files: {
        "unchanged.py": { sha: "sha-unchanged", endpoints: [endpoint({ path: "/unchanged" })], functions: [] },
        "changed.py": { sha: "old-sha", endpoints: [endpoint({ path: "/old" })], functions: [] },
      },
      lines_scanned: 100,
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
        endpoints: [
          endpoint({ path: "/unchanged", file_path: "unchanged.py" }),
          endpoint({ path: "/new", file_path: "changed.py" }),
        ],
        functions: [],
        package_import_root: "app",
        lines_scanned: 42,
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
    expect(next.lines_scanned).toBe(42);
    expect(next.version).toBe(SURFACE_CACHE_VERSION);
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

  function cacheWith(overrides: Partial<SurfaceCacheFile> = {}): SurfaceCacheFile {
    return {
      version: SURFACE_CACHE_VERSION,
      repo_hash: "repo123",
      language: "python",
      framework: "fastapi",
      package_import_root: "app",
      captured_functions: true,
      files: {
        "a.py": { sha: "sha-a", endpoints: [endpoint({ file_path: "a.py" })], functions: [fn({ file_path: "a.py" })] },
      },
      lines_scanned: 100,
      updated_at: 1000,
      ...overrides,
    };
  }

  function writeRaw(contents: string): void {
    fs.mkdirSync(path.join(workingDir, ".synapse"), { recursive: true });
    fs.writeFileSync(path.join(workingDir, ".synapse", "surface_cache.json"), contents, "utf-8");
  }

  it("ignores a cache from an older format (no version / lines_scanned)", () => {
    const { version: _v, lines_scanned: _l, ...old } = cacheWith();
    writeRaw(JSON.stringify(old));
    expect(readSurfaceCache(workingDir, "repo123")).toBeNull();
  });

  it("ignores valid JSON with the wrong shape instead of crashing later", () => {
    writeRaw(JSON.stringify(cacheWith({ files: { "a.py": { sha: 1 } } as never })));
    expect(readSurfaceCache(workingDir, "repo123")).toBeNull();
    writeRaw("null");
    expect(readSurfaceCache(workingDir, "repo123")).toBeNull();
    writeRaw("[]");
    expect(readSurfaceCache(workingDir, "repo123")).toBeNull();
  });

  it("cacheToManifest drops functions for Auto and carries lines_scanned", () => {
    const manifest = cacheToManifest(cacheWith(), { captureFunctions: false });
    expect(manifest.endpoints).toHaveLength(1);
    expect(manifest.functions).toEqual([]);
    expect(manifest.lines_scanned).toBe(100);
  });

  it("isCacheUsable: needs function data for Custom and something to reuse", () => {
    expect(isCacheUsable(null, false)).toBe(false);
    expect(isCacheUsable(cacheWith(), false)).toBe(true);
    expect(isCacheUsable(cacheWith(), true)).toBe(true);
    expect(isCacheUsable(cacheWith({ captured_functions: false }), true)).toBe(false);
    expect(isCacheUsable(cacheWith({ files: {} }), false)).toBe(false);
    const fnOnly = cacheWith({
      files: { "a.py": { sha: "s", endpoints: [], functions: [fn()] } },
    });
    expect(isCacheUsable(fnOnly, false)).toBe(false);
    expect(isCacheUsable(fnOnly, true)).toBe(true);
  });

  it("buildSurfaceCache drops files that the new scan no longer found", () => {
    const previous = cacheWith({
      files: {
        "kept.py": { sha: "k", endpoints: [endpoint({ file_path: "kept.py" })], functions: [] },
        "deleted.py": { sha: "d", endpoints: [endpoint({ file_path: "deleted.py" })], functions: [] },
      },
    });
    const next = buildSurfaceCache({
      repoHash: "repo123",
      manifest: {
        language: "python",
        framework: null,
        endpoints: [endpoint({ file_path: "kept.py" })],
        functions: [],
        package_import_root: "app",
      },
      ledgerRecords: [],
      previous,
      captureFunctions: false,
    });
    expect(Object.keys(next.files)).toEqual(["kept.py"]);
    // Nothing was parsed, so the framework from the last scan is kept.
    expect(next.framework).toBe("fastapi");
  });
});
