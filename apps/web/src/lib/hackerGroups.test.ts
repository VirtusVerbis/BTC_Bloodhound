import { describe, expect, it } from "vitest";
import {
  groupHackersForDropdown,
  isHackerRecent,
  type Hacker,
  type RecentHackerEntry,
} from "./hackerGroups";

const hackers: Hacker[] = [
  {
    address: "bc1qh1",
    label: "Hacker 1",
    source: "admin",
    totalReceivedSats: 1_000_000,
    recentVictimCount: 2,
    recentDownstreamCount: 1,
  },
  {
    address: "bc1qh2",
    label: "Hacker 2",
    source: "admin",
    totalReceivedSats: 500_000,
  },
];

const recentHackers: RecentHackerEntry[] = [
  {
    address: "bc1qh1",
    at: "2026-08-27T00:00:00.000Z",
    victims: 2,
    downstream: 1,
  },
];

describe("hackerGroups recent cache", () => {
  it("flags recent hackers from global cache", () => {
    const recentSet = new Set(recentHackers.map((entry) => entry.address));
    expect(isHackerRecent("bc1qh1", recentSet)).toBe(true);
    expect(isHackerRecent("bc1qh2", recentSet)).toBe(false);
  });

  it("groups recent hackers at top of dropdown", () => {
    const groups = groupHackersForDropdown(hackers, recentHackers);
    expect(groups[0]?.label).toBe("Recently updated");
    expect(groups[0]?.items[0]?.address).toBe("bc1qh1");
    expect(groups.some((g) => g.items.some((h) => h.address === "bc1qh1") && g.source !== "__recent__")).toBe(
      false,
    );
  });
});
