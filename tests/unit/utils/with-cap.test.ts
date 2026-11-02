import { describe, it, expect } from "vitest";
import { withCap } from "../../../src/utils/with-cap.js";

describe("withCap", () => {
  it("resolves as soon as the promise settles", async () => {
    const t0 = Date.now();
    await withCap(Promise.resolve("x"), 5_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("stops waiting at the cap when the promise hangs", async () => {
    const t0 = Date.now();
    await withCap(new Promise(() => {}), 50);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(40);
    expect(waited).toBeLessThan(1_000);
  });

  it("never rejects", async () => {
    await expect(withCap(Promise.reject(new Error("nope")), 50)).resolves.toBeUndefined();
  });
});
