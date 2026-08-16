import { describe, expect, it } from "vitest";
import { createCpuGuard } from "./cpuGuard.js";

describe("createCpuGuard", () => {
  it("tracks sync work and trips when budget exceeded", () => {
    const guard = createCpuGuard(0.01);
    let n = 0;
    while (!guard.exceeded() && n < 10_000) {
      guard.run(() => {
        n++;
      });
    }
    expect(guard.exceeded()).toBe(true);
    expect(guard.tripped()).toBe(true);
  });

  it("is a no-op when maxMs is 0", () => {
    const guard = createCpuGuard(0);
    expect(guard.run(() => 42)).toBe(42);
    expect(guard.exceeded()).toBe(false);
  });
});
