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
    pollHackerEnqueuePerCron: 1,
    hackerMaintenanceEveryNCrons: 10,
    downstreamPollIntervalSec: 600,
    downstreamPollEnqueuePerCron: 10,
    maxCrawlDepth: 5,
    maxGraphDepth: 2,
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
    seedFilePath: "./config/watchlist.seed.json",
    localWatchlistPath: "./config/watchlist.local.json",
    seedDataJson: null,
    localWatchlistDataJson: null,
    indexerRebuildMode: false,
    processTxRebuildPriority: JOB_PRIORITY.PROCESS_TX_REBUILD,
    corsOrigins: ["http://localhost:5173"],
    corsOriginsFromEnv: false,
    environment: "test",
    getRateLimit: 120,
    getRateWindowSec: 60,
    graphRateLimit: 30,
    graphRateWindowSec: 60,
    maxGraphVictims: 1000,
    maxGraphDownstream: 1000,
    ...overrides,
  };
}

function mockStore(overrides: Partial<Store> = {}): Store {
  return {
    countActiveJobs: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as Store;
}

describe("isRebuildActive", () => {
  it("returns false when no process_tx jobs and env flag off", async () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockResolvedValue(0) });
    expect(await isRebuildActive(store, baseConfig())).toBe(false);
  });

  it("returns true when process_tx jobs are active", async () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockResolvedValue(3) });
    expect(await isRebuildActive(store, baseConfig())).toBe(true);
    expect(store.countActiveJobs).toHaveBeenCalledWith("process_tx");
  });

  it("returns true when INDEXER_REBUILD_MODE is set", async () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockResolvedValue(0) });
    expect(await isRebuildActive(store, baseConfig({ indexerRebuildMode: true }))).toBe(true);
  });
});

describe("processTxPriority", () => {
  it("returns normal priority when rebuild inactive", async () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockResolvedValue(0) });
    expect(await processTxPriority(store, baseConfig())).toBe(JOB_PRIORITY.PROCESS_TX);
  });

  it("returns elevated priority when rebuild active", async () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockResolvedValue(1) });
    expect(await processTxPriority(store, baseConfig())).toBe(JOB_PRIORITY.PROCESS_TX_REBUILD);
  });

  it("respects custom PROCESS_TX_REBUILD_PRIORITY from config", async () => {
    const store = mockStore({ countActiveJobs: vi.fn().mockResolvedValue(1) });
    expect(await processTxPriority(store, baseConfig({ processTxRebuildPriority: 15 }))).toBe(15);
  });
});
