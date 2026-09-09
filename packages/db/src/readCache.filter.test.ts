import { describe, expect, it } from "vitest";
import { filterFlaggedHackersCache, type FlaggedHackerCacheEntry } from "./readCache.js";

const rows: FlaggedHackerCacheEntry[] = [
  {
    address: "bc1qAlphaHacker",
    role: "hacker",
    label: "Alpha",
    source: "admin",
    isFlaggedHacker: true,
    totalReceivedSats: 5000,
    liveBalanceSats: null,
    liveBalanceAt: null,
    lastGraphActivityAt: null,
  },
  {
    address: "bc1qBetaHacker",
    role: "hacker",
    label: "Beta",
    source: "admin",
    isFlaggedHacker: true,
    totalReceivedSats: 0,
    liveBalanceSats: null,
    liveBalanceAt: null,
    lastGraphActivityAt: null,
  },
];

describe("filterFlaggedHackersCache", () => {
  it("returns all rows when no filters", () => {
    expect(filterFlaggedHackersCache(rows)).toHaveLength(2);
  });

  it("filters activeOnly by totalReceivedSats", () => {
    expect(filterFlaggedHackersCache(rows, { activeOnly: true }).map((r) => r.address)).toEqual([
      "bc1qAlphaHacker",
    ]);
  });

  it("filters by q on address case-insensitively", () => {
    expect(filterFlaggedHackersCache(rows, { q: "beta" }).map((r) => r.address)).toEqual([
      "bc1qBetaHacker",
    ]);
  });

  it("filters by q on label", () => {
    expect(filterFlaggedHackersCache(rows, { q: "alpha" }).map((r) => r.address)).toEqual([
      "bc1qAlphaHacker",
    ]);
  });

  it("applies activeOnly and q together", () => {
    expect(
      filterFlaggedHackersCache(rows, { q: "hacker", activeOnly: true }).map((r) => r.address),
    ).toEqual(["bc1qAlphaHacker"]);
  });
});
