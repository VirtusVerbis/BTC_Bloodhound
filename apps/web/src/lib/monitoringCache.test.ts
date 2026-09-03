import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractMonitoringSnapshot,
  hasMeaningfulMonitoring,
  loadMonitoringCache,
  mergeMonitoringForAbout,
  MONITORING_CACHE_KEY,
  saveMonitoringCache,
  saveMonitoringCacheFromD1Quota,
  type MonitoringSnapshot,
} from "./monitoringCache";

const sampleLive = {
  lastActivityAt: "2026-09-03T20:06:23.000Z",
  lastChainApiAt: "2026-09-03T20:06:23.000Z",
  lastExternalSyncAt: "2026-08-10T06:10:29.000Z",
  lastJobAt: "2026-09-02T07:46:12.000Z",
  lastCompletedJobType: "expand_downstream",
  lastCompletedJobDurationMs: 530,
  monitoringActive: false,
  externalSources: [{ source: "coldcardwatch.com", lastSyncAt: "2026-08-07T02:55:57.000Z", lastAddressCount: 16 }],
  d1Quota: {
    blocked: false,
    rowsRead: 42,
    rowsWritten: 1,
    workersRequests: 5,
    rowsReadLimit: 5_000_000,
    rowsWrittenLimit: 100_000,
    workersRequestsLimit: 100_000,
  },
};

const sampleCache: MonitoringSnapshot = {
  savedAt: "2026-09-03T19:00:00.000Z",
  lastActivityAt: "2026-09-03T18:00:00.000Z",
  lastChainApiAt: "2026-09-03T18:00:00.000Z",
  monitoringActive: true,
  d1Quota: {
    rowsRead: 100,
    rowsWritten: 2,
    workersRequests: 3,
    rowsReadLimit: 5_000_000,
    rowsWrittenLimit: 100_000,
    workersRequestsLimit: 100_000,
  },
};

describe("hasMeaningfulMonitoring", () => {
  it("returns true when lastActivityAt is set", () => {
    expect(hasMeaningfulMonitoring({ lastActivityAt: "2026-09-03T12:00:00.000Z" })).toBe(true);
  });

  it("returns true when external sources exist", () => {
    expect(
      hasMeaningfulMonitoring({
        externalSources: [{ source: "x", lastSyncAt: null, lastAddressCount: null }],
      }),
    ).toBe(true);
  });

  it("returns true when d1 quota usage is non-zero", () => {
    expect(
      hasMeaningfulMonitoring({
        d1Quota: {
          rowsRead: 1,
          rowsWritten: 0,
          workersRequests: 0,
          rowsReadLimit: 5_000_000,
          rowsWrittenLimit: 100_000,
          workersRequestsLimit: 100_000,
        },
      }),
    ).toBe(true);
  });

  it("returns false for empty degraded shape", () => {
    expect(hasMeaningfulMonitoring({ lastActivityAt: null, externalSources: [] })).toBe(false);
    expect(hasMeaningfulMonitoring(null)).toBe(false);
  });
});

describe("mergeMonitoringForAbout", () => {
  it("prefers live data over cache", () => {
    const merged = mergeMonitoringForAbout(sampleLive, sampleCache);
    expect(merged.source).toBe("live");
    expect(merged.retrievedAt).toBeNull();
    expect(merged.data?.lastActivityAt).toBe(sampleLive.lastActivityAt);
  });

  it("falls back to cache when live is degraded", () => {
    const merged = mergeMonitoringForAbout(
      { lastActivityAt: null, externalSources: [], monitoringActive: false },
      sampleCache,
    );
    expect(merged.source).toBe("cached");
    expect(merged.retrievedAt).toBe(sampleCache.savedAt);
    expect(merged.data?.lastActivityAt).toBe(sampleCache.lastActivityAt);
  });

  it("returns null when neither live nor cache is meaningful", () => {
    const merged = mergeMonitoringForAbout(null, null);
    expect(merged.data).toBeNull();
  });
});

describe("monitoring cache storage", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips save and load", () => {
    const snapshot = extractMonitoringSnapshot(sampleLive, "2026-09-03T20:00:00.000Z");
    saveMonitoringCache(snapshot);
    expect(loadMonitoringCache()).toEqual(snapshot);
    expect(storage.has(MONITORING_CACHE_KEY)).toBe(true);
  });

  it("returns null for corrupt cache", () => {
    storage.set(MONITORING_CACHE_KEY, "{not valid");
    expect(loadMonitoringCache()).toBeNull();
  });

  it("merges d1 quota into existing cache", () => {
    saveMonitoringCache(sampleCache);
    saveMonitoringCacheFromD1Quota({
      rowsRead: 5_000_001,
      rowsWritten: 84_200,
      workersRequests: 92_100,
      rowsReadLimit: 5_000_000,
      rowsWrittenLimit: 100_000,
      workersRequestsLimit: 100_000,
      blocked: true,
    });
    const loaded = loadMonitoringCache();
    expect(loaded?.lastActivityAt).toBe(sampleCache.lastActivityAt);
    expect(loaded?.d1Quota?.rowsRead).toBe(5_000_001);
    expect(loaded?.d1Quota?.blocked).toBe(true);
  });
});
