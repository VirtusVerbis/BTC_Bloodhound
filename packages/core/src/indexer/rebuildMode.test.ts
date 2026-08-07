import { describe, expect, it, vi } from "vitest";
import { isRebuildActive, processTxPriority } from "./rebuildMode.js";
import { JOB_PRIORITY } from "../config.js";
import type { AppConfig } from "../config.js";
import type { Store } from "@cointrace/db";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: "file:./test.db",
    esploraBase: "https://blockstream.info/api",
    mempoolBase: "https://mempool.space/api",
    rateLimitMs: 3000,
    jobsPerTick: 1,
    cronIntervalSec: 60,
    crawlEnqueuePerCron: 5,
    downstreamPollIntervalSec: 600,
    downstreamPollEnqueuePerCron: 10,
    maxCrawlDepth: 5,
    maxGraphDepth: 2,
    maxGraphOutputs: 20,
    minEdgeSats: 1000,
    balanceRefreshIntervalSec: 300,
    btcUsdPriceRefreshIntervalSec: 60,
    coldcardwatchSyncIntervalSec: 3600,
    coldcardwatchBase: "https://coldcardwatch.com",
    vercelTrackersSyncIntervalSec: 3600,
    coldcardSweepWatchBase: "https://coldcard-watch.vercel.app",
    coldcardHackTrackerBase: "https://coldcard-hack-tracker.vercel.app",
    monitoringStaleSec: 600,
    apiThresholdCooldownSec: 300,
    backfillTxsPerJob: 5,
    backfillMaxTxs: 10000,
    backfillHealAuditIntervalSec: 86400,
    backfillHealAuditPerCron: 1,
    backfillHealTxSlack: 5,
    adminToken: "test",
    seedFilePath: "./config/watchlist.seed.json",
    localWatchlistPath: "./config/watchlist.local.json",
    indexerRebuildMode: false,
    processTxRebuildPriority: JOB_PRIORITY.PROCESS_TX_REBUILD,
    ...overrides,
  };
}

function mockStore(overrides: Partial<Store> = {}): Store {
  return {
    countActiveJobs: vi.fn().mockReturnValue(0),
    ...overrides,
  } as unknown as Store;
}

describe("isRebuildActive", () => {
  it("returns false when no process_tx jobs and env flag off", () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockReturnValue(0) });
    expect(isRebuildActive(store, baseConfig())).toBe(false);
  });

  it("returns true when process_tx jobs are active", () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockReturnValue(3) });
    expect(isRebuildActive(store, baseConfig())).toBe(true);
    expect(store.countActiveJobs).toHaveBeenCalledWith("process_tx");
  });

  it("returns true when INDEXER_REBUILD_MODE is set", () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockReturnValue(0) });
    expect(isRebuildActive(store, baseConfig({ indexerRebuildMode: true }))).toBe(true);
  });
});

describe("processTxPriority", () => {
  it("returns normal priority when rebuild inactive", () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockReturnValue(0) });
    expect(processTxPriority(store, baseConfig())).toBe(JOB_PRIORITY.PROCESS_TX);
  });

  it("returns elevated priority when rebuild active", () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockReturnValue(1) });
    expect(processTxPriority(store, baseConfig())).toBe(JOB_PRIORITY.PROCESS_TX_REBUILD);
  });

  it("respects custom PROCESS_TX_REBUILD_PRIORITY from config", () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockReturnValue(1) });
    expect(processTxPriority(store, baseConfig({ processTxRebuildPriority: 15 }))).toBe(15);
  });
});
