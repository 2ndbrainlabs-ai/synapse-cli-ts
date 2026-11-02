// `synapse build` language detection (SYN-353).
//
// Detection took the first root marker in a fixed order, Python first. Gitea
// has go.mod plus a pyproject.toml and a tsconfig.json, so it was built as
// Python, the Python extractor found nothing and build printed the Django
// "No route decorators" message.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLanguage, extractSurfaceStreamed } from "../../../src/extractors/core/extractor.js";
import type { SessionManager } from "../../../src/session/session-manager.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-detect-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const GO_ROUTES = `package main

import "net/http"

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /patients", listPatients)
	mux.HandleFunc("POST /patients", createPatient)
}
`;

/** Gitea's shape: Go backend, Python tooling config, TypeScript frontend. */
function giteaLike(): string {
  return repo({
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "pyproject.toml": "[tool.djlint]\n",
    "tsconfig.json": "{}\n",
    "main.go": GO_ROUTES,
    "models/user.go": "package models\n",
    "models/repo.go": "package models\n",
    "routers/web.go": "package routers\n",
    "tools/lint.py": "print('lint')\n",
    "web_src/index.ts": "export {};\n",
    "web_src/app.tsx": "export {};\n",
  });
}

describe("detectLanguage", () => {
  it("detects a Go repo that also has pyproject.toml and tsconfig.json as Go", () => {
    expect(detectLanguage(giteaLike())).toBe("go");
  });

  it("keeps Python for a Python repo with a small TypeScript frontend", () => {
    const dir = repo({
      "pyproject.toml": "[project]\nname='x'\n",
      "tsconfig.json": "{}\n",
      "app/main.py": "",
      "app/models.py": "",
      "app/services.py": "",
      "web/index.ts": "",
    });
    expect(detectLanguage(dir)).toBe("python");
  });

  it("detects each single-language repo from its marker", () => {
    expect(detectLanguage(repo({ "go.mod": "module m\n", "main.go": "" }))).toBe("go");
    expect(detectLanguage(repo({ "pom.xml": "<project/>", "src/A.java": "" }))).toBe("java");
    expect(detectLanguage(repo({ "tsconfig.json": "{}", "src/index.ts": "" }))).toBe("typescript");
    expect(detectLanguage(repo({ "requirements.txt": "", "main.py": "" }))).toBe("python");
    expect(detectLanguage(repo({ "Cargo.toml": "", "src/main.rs": "" }))).toBe("rust");
  });

  it("ignores languages that have no marker when a marked language has source files", () => {
    // Python scripts outnumber Go files, but only Go has a root marker.
    const dir = repo({ "go.mod": "module m\n", "main.go": "", "a.py": "", "b.py": "", "c.py": "" });
    expect(detectLanguage(dir)).toBe("go");
  });

  it("falls back to the most common extension when there is no marker", () => {
    expect(detectLanguage(repo({ "Program.cs": "", "Api.cs": "", "x.py": "" }))).toBe("csharp");
  });

  it("does not count vendored Go code", () => {
    const vendored: Record<string, string> = {};
    for (let i = 0; i < 5; i++) vendored[`vendor/lib/f${i}.go`] = "";
    const dir = repo({ ...vendored, "requirements.txt": "", "go.mod": "module m\n", "app.py": "", "main.go": "", "x.py": "" });
    expect(detectLanguage(dir)).toBe("python");
  });

  it("uses the first marker when no source files are found", () => {
    expect(detectLanguage(repo({ "pyproject.toml": "", "go.mod": "" }))).toBe("python");
  });

  it("throws when nothing supported is found", () => {
    expect(() => detectLanguage(repo({ "README.md": "" }))).toThrow(/Could not detect a supported language/);
  });
});

describe("extractSurfaceStreamed on a multi-language Go repo", () => {
  it("runs the Go extractor and finds the Go routes", async () => {
    const session = { signal: new AbortController().signal } as unknown as SessionManager;
    const manifest = await extractSurfaceStreamed({ workingDir: giteaLike(), session });

    expect(manifest.language).toBe("go");
    expect(manifest.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      "GET /patients",
      "POST /patients",
    ]);
  });
});
