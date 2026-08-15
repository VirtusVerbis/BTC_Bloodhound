import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  clearHackerLastViewedForTests,
  getHackerLastViewedMap,
  hasHackerLastViewedState,
  seedLastViewedFromHackers,
} from "./hackerLastViewed";
import { groupHackersForDropdown, isHackerUnread, type Hacker } from "./hackerGroups";

const hackers: Hacker[] = [
  {
    address: "bc1qh1",
    label: "Hacker 1",
    source: "admin",
    totalReceivedSats: 1_000_000,
    lastGraphActivityAt: "2025-06-01T00:00:00.000Z",
    recentVictimCount: 2,
    recentDownstreamCount: 1,
  },
  {
    address: "bc1qh2",
    label: "Hacker 2",
    source: "admin",
    totalReceivedSats: 500_000,
    lastGraphActivityAt: "2025-01-01T00:00:00.000Z",
  },
];

describe("hackerLastViewed", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    clearHackerLastViewedForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("first visit seeds baseline and marks no hackers unread", () => {
    expect(hasHackerLastViewedState()).toBe(false);
    seedLastViewedFromHackers(hackers);
    expect(hasHackerLastViewedState()).toBe(true);
    const map = getHackerLastViewedMap();
    expect(map["bc1qh1"]).toBe("2025-06-01T00:00:00.000Z");
    expect(isHackerUnread(hackers[0]!, map["bc1qh1"])).toBe(false);
    expect(isHackerUnread(hackers[1]!, map["bc1qh2"])).toBe(false);
    const groups = groupHackersForDropdown(hackers, map);
    expect(groups.some((g) => g.label === "Recently updated")).toBe(false);
  });

  it("activity after baseline shows unread until viewed", () => {
    seedLastViewedFromHackers(hackers);
    const map = getHackerLastViewedMap();
    const updated: Hacker = {
      ...hackers[0]!,
      lastGraphActivityAt: "2025-07-01T00:00:00.000Z",
    };
    expect(isHackerUnread(updated, map[updated.address])).toBe(true);
    const groups = groupHackersForDropdown([updated, hackers[1]!], map);
    expect(groups[0]?.label).toBe("Recently updated");
    expect(groups[0]?.items[0]?.address).toBe("bc1qh1");
  });
});
