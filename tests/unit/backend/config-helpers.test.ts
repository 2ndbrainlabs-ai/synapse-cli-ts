// tests/unit/backend/config-helpers.test.ts
//
// Small pure helper — resolveEffectiveMode. Must be deterministic and never
// touch disk. Provider/key resolution is covered in tests/unit/config/.

import { describe, expect, it } from "vitest";
import { resolveEffectiveMode } from "../../../src/config/manager.js";

describe("resolveEffectiveMode", () => {
  it("--local flag returns local", () => {
    expect(resolveEffectiveMode(true)).toBe("local");
  });

  it("no flag returns hosted", () => {
    expect(resolveEffectiveMode(false)).toBe("hosted");
  });
});
