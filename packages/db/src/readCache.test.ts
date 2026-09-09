import { describe, expect, it } from "vitest";
import { pollDueCacheTtlSec } from "./readCache.js";

describe("pollDueCacheTtlSec", () => {
  it("returns 0 when interval is 0", () => {
    expect(pollDueCacheTtlSec(0)).toBe(0);
  });

  it("returns full interval for prod-style 1200s poll interval", () => {
    expect(pollDueCacheTtlSec(1200)).toBe(1200);
  });

  it("returns full interval for 600s test fixtures", () => {
    expect(pollDueCacheTtlSec(600)).toBe(600);
  });

  it("clamps negative intervals to 0", () => {
    expect(pollDueCacheTtlSec(-10)).toBe(0);
  });
});
