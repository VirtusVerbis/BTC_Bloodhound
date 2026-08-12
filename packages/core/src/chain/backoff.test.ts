import { describe, expect, it } from "vitest";
import { providerBackoffSec } from "./backoff.js";

describe("providerBackoffSec", () => {
  const base = 300;
  const max = 3600;

  it("returns base for first strike", () => {
    expect(providerBackoffSec(1, base, max)).toBe(300);
  });

  it("doubles per consecutive strike", () => {
    expect(providerBackoffSec(2, base, max)).toBe(600);
    expect(providerBackoffSec(3, base, max)).toBe(1200);
    expect(providerBackoffSec(4, base, max)).toBe(2400);
  });

  it("caps at maxSec", () => {
    expect(providerBackoffSec(5, base, max)).toBe(3600);
    expect(providerBackoffSec(10, base, max)).toBe(3600);
  });

  it("uses Retry-After when larger than exponential", () => {
    expect(providerBackoffSec(1, base, max, 900)).toBe(900);
  });

  it("clamps strikes below 1 to first-tier backoff", () => {
    expect(providerBackoffSec(0, base, max)).toBe(300);
  });
});
