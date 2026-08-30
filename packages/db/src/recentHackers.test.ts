import { describe, expect, it } from "vitest";
import {
  mergeRecentHackerActivity,
  parseRecentHackersJson,
  recentHackersEqual,
  type RecentHackerEntry,
} from "./recentHackers.js";

describe("recentHackers", () => {
  it("parseRecentHackersJson handles invalid input", () => {
    expect(parseRecentHackersJson(null)).toEqual([]);
    expect(parseRecentHackersJson("not-json")).toEqual([]);
    expect(parseRecentHackersJson("{}")).toEqual([]);
  });

  it("parseRecentHackersJson parses valid entries", () => {
    const raw = JSON.stringify([
      { address: "bc1qh1", at: "2025-06-01T00:00:00.000Z", victims: 2, downstream: 1 },
      { address: "", at: "2025-06-01T00:00:00.000Z" },
    ]);
    expect(parseRecentHackersJson(raw)).toEqual([
      { address: "bc1qh1", at: "2025-06-01T00:00:00.000Z", victims: 2, downstream: 1 },
    ]);
  });

  it("mergeRecentHackerActivity accumulates counts and keeps top N", () => {
    const existing: RecentHackerEntry[] = [
      { address: "a", at: "2025-01-01T00:00:00.000Z", victims: 1, downstream: 0 },
      { address: "b", at: "2025-01-02T00:00:00.000Z", victims: 0, downstream: 1 },
      { address: "c", at: "2025-01-03T00:00:00.000Z", victims: 1, downstream: 1 },
    ];
    const updates = new Map([
      ["a", { victims: 2, at: "2025-01-04T00:00:00.000Z" }],
      ["d", { downstream: 1, at: "2025-01-05T00:00:00.000Z" }],
    ]);
    const merged = mergeRecentHackerActivity(existing, updates, 3);
    expect(merged).toEqual([
      { address: "d", at: "2025-01-05T00:00:00.000Z", victims: 0, downstream: 1 },
      { address: "a", at: "2025-01-04T00:00:00.000Z", victims: 3, downstream: 0 },
      { address: "c", at: "2025-01-03T00:00:00.000Z", victims: 1, downstream: 1 },
    ]);
  });

  it("recentHackersEqual compares entry lists", () => {
    const a: RecentHackerEntry[] = [
      { address: "x", at: "2025-01-01T00:00:00.000Z", victims: 1, downstream: 0 },
    ];
    const b: RecentHackerEntry[] = [
      { address: "x", at: "2025-01-01T00:00:00.000Z", victims: 1, downstream: 0 },
    ];
    expect(recentHackersEqual(a, b)).toBe(true);
    expect(recentHackersEqual(a, [{ ...b[0]!, victims: 2 }])).toBe(false);
  });
});
