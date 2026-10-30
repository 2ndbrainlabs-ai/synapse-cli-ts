// The v1 engine and `synapse analyze` were removed (SYN-257). Scripts that
// still use them get a clear message and a non-zero exit code.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRemovedBuildOptions, runAnalyzeRemoved, V1_REMOVED_IN } from "../../../src/commands/removed.js";

let output: string;

beforeEach(() => {
  output = "";
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    output += a.map(String).join(" ") + "\n";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("synapse build --engine", () => {
  it("runs the build when --engine is omitted or v2", () => {
    // commander's defaults for the hidden --no-validate / --no-docs flags.
    expect(checkRemovedBuildOptions({ validate: true, docs: true })).toBe(true);
    expect(checkRemovedBuildOptions({ engine: "v2", validate: true, docs: true })).toBe(true);
    expect(output).toBe("");
    expect(process.exitCode).toBeUndefined();
  });

  it("explains that v1 was removed and exits non-zero", () => {
    expect(checkRemovedBuildOptions({ engine: "v1", output: "server.py" })).toBe(false);
    expect(output).toContain(`The v1 engine was removed in ${V1_REMOVED_IN}`);
    expect(output).toContain("synapse build");
    expect(process.exitCode).toBe(1);
  });

  it("rejects an unknown engine instead of falling back to another one", () => {
    expect(checkRemovedBuildOptions({ engine: "v3" })).toBe(false);
    expect(output).toContain('Unknown engine "v3"');
    expect(process.exitCode).toBe(1);
  });
});

describe("synapse build: removed v1-only flags", () => {
  it("names a single removed flag", () => {
    expect(checkRemovedBuildOptions({ output: "mcp_server.py" })).toBe(false);
    expect(output).toContain("-o/--output was a v1-only option");
    expect(process.exitCode).toBe(1);
  });

  it("names every removed flag that was passed", () => {
    expect(
      checkRemovedBuildOptions({ generate: true, validate: false, docs: false }),
    ).toBe(false);
    expect(output).toContain("-g/--generate, --no-validate, --no-docs were v1-only options");
    expect(process.exitCode).toBe(1);
  });
});

describe("synapse analyze", () => {
  it("explains that analyze was removed and exits non-zero", () => {
    runAnalyzeRemoved();
    expect(output).toContain(`was removed in ${V1_REMOVED_IN}`);
    expect(output).toContain("synapse build");
    expect(process.exitCode).toBe(1);
  });
});
