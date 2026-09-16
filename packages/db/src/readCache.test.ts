import { describe, expect, it } from "vitest";
import {
  parseHackStatsRows,
  parseSyncSnapshot,
  pollDueCacheTtlSec,
} from "./readCache.js";

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

const validHackRows = [
  { id: "coldcard", victimCount: 1, hackerCount: 2, totalInSats: 100 },
  { id: "liquid", victimCount: 3, hackerCount: 4, totalInSats: 200 },
];

describe("parseHackStatsRows", () => {
  it("returns known hack ids in HACK_STAT_IDS order", () => {
    expect(parseHackStatsRows([...validHackRows].reverse())).toEqual(validHackRows);
  });

  it("returns undefined when a known id is missing", () => {
    expect(parseHackStatsRows([validHackRows[0]])).toBeUndefined();
  });

  it("returns undefined for garbage rows", () => {
    expect(parseHackStatsRows([{ id: "coldcard" }])).toBeUndefined();
    expect(parseHackStatsRows("nope")).toBeUndefined();
  });
});

describe("parseSyncSnapshot hacks", () => {
  const base = {
    v: 1 as const,
    at: "2026-01-01T00:00:00.000Z",
    params: { maxCrawlDepth: 5, downstreamPollIntervalSec: 600 },
    crawl: { crawlPendingCount: 0, crawlExpandedCount: 0, crawlMaxHopReached: 0 },
    monitor: { treeNodeCount: 0, downstreamPollDueCount: 0 },
    lastCompletedJob: { type: null, durationMs: null, at: null },
    stats: { victimCount: 1, hackerCount: 1, totalInSats: 0, totalOutSats: 0 },
  };

  it("keeps v:1 snapshots without hacks", () => {
    const parsed = parseSyncSnapshot(JSON.stringify(base));
    expect(parsed?.v).toBe(1);
    expect(parsed?.stats.hacks).toBeUndefined();
  });

  it("normalizes valid hacks and drops invalid ones", () => {
    const withHacks = parseSyncSnapshot(
      JSON.stringify({ ...base, stats: { ...base.stats, hacks: [...validHackRows].reverse() } }),
    );
    expect(withHacks?.stats.hacks).toEqual(validHackRows);

    const invalid = parseSyncSnapshot(
      JSON.stringify({ ...base, stats: { ...base.stats, hacks: [{ id: "coldcard" }] } }),
    );
    expect(invalid?.stats.hacks).toBeUndefined();
  });
});
