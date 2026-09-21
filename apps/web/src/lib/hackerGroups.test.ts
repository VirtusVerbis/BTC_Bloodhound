import { describe, expect, it } from "vitest";
import {
  filterHackers,
  flattenHackersForNav,
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
    hackId: "coldcard",
    totalReceivedSats: 1_000_000,
    recentVictimCount: 2,
    recentDownstreamCount: 1,
  },
  {
    address: "bc1qh2",
    label: "Hacker 2",
    source: "admin",
    hackId: "coldcard",
    totalReceivedSats: 500_000,
  },
  {
    address: "bc1ql1",
    label: "Liquid 1",
    source: "x",
    hackId: "liquid",
    totalReceivedSats: 3_000_000,
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

describe("filterHackers", () => {
  it("returns all hackers for empty or whitespace query", () => {
    expect(filterHackers(hackers, "")).toEqual(hackers);
    expect(filterHackers(hackers, "   ")).toEqual(hackers);
  });

  it("matches address substring case-insensitively", () => {
    expect(filterHackers(hackers, "BC1QH1").map((h) => h.address)).toEqual(["bc1qh1"]);
    expect(filterHackers(hackers, "ql1").map((h) => h.address)).toEqual(["bc1ql1"]);
  });

  it("matches label substring case-insensitively", () => {
    expect(filterHackers(hackers, "liquid").map((h) => h.address)).toEqual(["bc1ql1"]);
    expect(filterHackers(hackers, "HACKER 2").map((h) => h.address)).toEqual(["bc1qh2"]);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterHackers(hackers, "zzznomatch")).toEqual([]);
  });
});

describe("hackerGroups recent cache", () => {
  it("flags recent hackers from global cache", () => {
    const recentSet = new Set(recentHackers.map((entry) => entry.address));
    expect(isHackerRecent("bc1qh1", recentSet)).toBe(true);
    expect(isHackerRecent("bc1qh2", recentSet)).toBe(false);
  });

  it("groups recent hackers at top of dropdown", () => {
    const sections = groupHackersForDropdown(hackers, recentHackers);
    expect(sections.recent?.label).toBe("Last activity");
    expect(sections.recent?.items[0]?.address).toBe("bc1qh1");
    expect(
      sections.hackSections.some((hack) =>
        hack.sourceGroups.some((g) => g.items.some((h) => h.address === "bc1qh1")),
      ),
    ).toBe(false);
  });

  it("groups hackers under Coldcard and Liquid sections", () => {
    const sections = groupHackersForDropdown(hackers, []);
    expect(sections.hackSections.map((h) => h.hackId)).toEqual(["coldcard", "liquid"]);
    const coldcard = sections.hackSections.find((h) => h.hackId === "coldcard");
    const liquid = sections.hackSections.find((h) => h.hackId === "liquid");
    expect(coldcard?.sourceGroups[0]?.items.map((h) => h.address)).toEqual(["bc1qh1", "bc1qh2"]);
    expect(liquid?.sourceGroups[0]?.label).toBe("X");
    expect(liquid?.sourceGroups[0]?.items[0]?.address).toBe("bc1ql1");
  });

  it("flattens nav order as recent then hack sections", () => {
    const sections = groupHackersForDropdown(hackers, recentHackers);
    const flat = flattenHackersForNav(sections);
    expect(flat.map((h) => h.address)).toEqual(["bc1qh1", "bc1qh2", "bc1ql1"]);
  });
});
