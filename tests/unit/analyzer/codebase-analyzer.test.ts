// `synapse analyze` file and line counts for repos that are not Python
// (SYN-274). Before the fix only files with a registered parser (.py) were
// counted, so Go, Java and TypeScript repos reported 0 files and 0 lines.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeCodebase } from "../../../src/analyzer/codebase-analyzer.js";
import { registerParser } from "../../../src/parsers/registry.js";
import { PythonParser } from "../../../src/parsers/python/index.js";

let repo: string;

function write(rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(() => {
  registerParser(new PythonParser());
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-analyzer-"));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("analyzeCodebase: non-Python repos (SYN-274)", () => {
  it("counts Go files and lines", () => {
    write("go.mod", "module example.com/app\n");
    write("main.go", "package main\n\nfunc main() {\n}\n");
    write("routers/api.go", "package routers\n\nfunc Register() {}\n");

    const [, stats] = analyzeCodebase(repo);

    expect(stats.file_count).toBe(2);
    expect(stats.total_lines_analyzed).toBe(7);
    expect(stats.languages).toEqual({ Go: 2 });
    expect(stats.unsupported_languages).toEqual({});
  });

  it("counts Java and TypeScript files", () => {
    write("src/main/java/App.java", "class App {\n  void run() {}\n}\n");
    write("web/routes.ts", "export const a = 1;\n");
    write("web/view.tsx", "export const V = () => null;\n");

    const [, stats] = analyzeCodebase(repo);

    expect(stats.file_count).toBe(3);
    expect(stats.total_lines_analyzed).toBe(5);
    expect(stats.languages).toEqual({ Java: 1, TypeScript: 2 });
  });

  it("names unsupported languages without counting or charging their lines", () => {
    write("index.php", "<?php\necho 'hi';\n");
    write("app/models/user.rb", "class User\nend\n");
    write("src/app.js", "module.exports = {};\n");

    const [, stats] = analyzeCodebase(repo);

    expect(stats.file_count).toBe(0);
    expect(stats.total_lines_analyzed).toBe(0);
    expect(stats.unsupported_languages).toEqual({ PHP: 1, Ruby: 1, JavaScript: 1 });
  });

  it("still parses Python structure and adds other languages to the totals", () => {
    write("app.py", "class A:\n    def m(self):\n        pass\n\ndef f():\n    return 1\n");
    write("svc/main.go", "package main\n");

    const [, stats] = analyzeCodebase(repo);

    expect(stats.file_count).toBe(2);
    expect(stats.total_lines_analyzed).toBe(7);
    expect(stats.languages).toEqual({ Python: 1, Go: 1 });
    expect(stats.class_count).toBe(1);
    expect(stats.function_count).toBe(1);
    expect(stats.method_count).toBe(1);
  });

  it("skips vendored and build-output directories", () => {
    write("main.go", "package main\n");
    write("vendor/github.com/x/y/y.go", "package y\n");
    write("target/classes/Gen.java", "class Gen {}\n");
    write("bin/obj/Gen.cs", "class Gen {}\n");
    write("node_modules/pkg/index.ts", "export {};\n");

    const [, stats] = analyzeCodebase(repo);

    expect(stats.file_count).toBe(1);
    expect(stats.languages).toEqual({ Go: 1 });
  });
});
