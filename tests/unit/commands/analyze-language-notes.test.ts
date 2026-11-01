// The analyze summary explains what its counts cover when a repo is not
// Python-only, instead of silently showing 0 files (SYN-274).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProjectStatistics } from "../../../src/analyzer/codebase-analyzer.js";
import { formatCounts, renderLanguageNotes } from "../../../src/commands/analyze.js";
import { stripAnsi } from "../../../src/ui/theme.js";

let output: string;

function stats(over: Partial<ProjectStatistics>): ProjectStatistics {
  return {
    project_name: "p",
    directory_count: 1,
    file_count: 0,
    total_lines_analyzed: 0,
    module_count: 0,
    class_count: 0,
    function_count: 0,
    method_count: 0,
    total_callable_count: 0,
    languages: {},
    unsupported_languages: {},
    modules: [],
    ...over,
  };
}

beforeEach(() => {
  output = "";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    output += stripAnsi(a.map(String).join(" ")) + "\n";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analyze language notes (SYN-274)", () => {
  it("formats counts largest first", () => {
    expect(formatCounts({ Python: 1, Go: 12, Java: 1 })).toBe("Go (12), Java (1), Python (1)");
    expect(formatCounts({})).toBe("");
  });

  it("says nothing extra for a Python-only repo", () => {
    renderLanguageNotes(stats({ file_count: 3, languages: { Python: 3 } }));
    expect(output).toBe("");
  });

  it("explains that class and function counts are Python-only for a Go repo", () => {
    renderLanguageNotes(stats({ file_count: 3, languages: { Go: 3 } }));
    expect(output).toContain("cover Python only");
    expect(output).toContain("Go files are counted by files and lines");
  });

  it("warns about unsupported languages", () => {
    renderLanguageNotes(stats({ unsupported_languages: { PHP: 40, Ruby: 2 } }));
    expect(output).toContain("does not support yet: PHP (40), Ruby (2)");
    expect(output).not.toContain("No supported source files");
  });

  it("warns when no source files were found at all", () => {
    renderLanguageNotes(stats({}));
    expect(output).toContain("No supported source files found");
  });
});
