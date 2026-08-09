import { describe, expect, it, vi } from "vitest";
import { scheduleBtcUsdPriceRefresh, scheduleDownstreamCrawl, scheduleHackerBackfillHeal } from "./crawl.js";
import { JOB_PRIORITY } from "../config.js";
import type { AppConfig } from "../config.js";
import type { Store } from "@cointrace/db";

function baseConfig(): AppConfig {
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
    seedDataJson: null,
    localWatchlistDataJson: null,
    indexerRebuildMode: false,
    processTxRebuildPriority: JOB_PRIORITY.PROCESS_TX_REBUILD,
    corsOrigins: ["http://localhost:5173"],
    corsOriginsFromEnv: false,
    environment: "test",
    expandRateLimit: 5,
    expandRateWindowSec: 600,
    expandMaxActive: 20,
    getRateLimit: 120,
    getRateWindowSec: 60,
    graphRateLimit: 30,
    graphRateWindowSec: 60,
    adminRateLimit: 10,
    adminRateWindowSec: 3600,
    maxGraphVictims: 1000,
    maxGraphDownstream: 1000,
  };
}

function mockStore(overrides: Partial<Store> = {}): Store {
  return {
    listHackers: vi.fn().mockResolvedValue([]),
    hasPendingJob: vi.fn().mockResolvedValue(false),
    countActiveJobs: vi.fn().mockResolvedValue(0),
    getAddress: vi.fn(),
    getBackfillState: vi.fn(),
    enqueueJob: vi.fn(),
    getBackfillHealAuditIndex: vi.fn().mockResolvedValue(0),
    setBackfillHealAuditIndex: vi.fn(),
    getBtcUsdPrice: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as Store;
}

describe("scheduleHackerBackfillHeal", () => {
  it("enqueues backfill when hacker is backfilling and no job exists", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue([{ address: addr }]),
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "backfilling" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: { chainCursor: "txabc", pagesExhausted: false },
        backfillComplete: false,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      expect.objectContaining({ address: addr, chainCursor: "txabc" }),
      2,
    );
  });

  it("enqueues backfill when expanded but backfill_complete is false", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue([{ address: addr }]),
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: null,
        backfillComplete: false,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      { address: addr },
      2,
    );
  });

  it("enqueues audit when expanded, complete, and audit is due", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue([{ address: addr }]),
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: null,
        backfillComplete: true,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith("audit_hacker_backfill", { address: addr }, 2);
  });

  it("skips when backfill job is already pending", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue([{ address: addr }]),
      hasPendingJob: vi.fn().mockImplementation(async (type: string) => type === "backfill_hacker_address"),
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "backfilling" }),
    });

    await scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("respects audit per cron cap", async () => {
    const hackers = [
      { address: "bc1qa" },
      { address: "bc1qb" },
      { address: "bc1qc" },
    ];
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue(hackers),
      getAddress: vi.fn().mockResolvedValue({ expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: null,
        backfillComplete: true,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledTimes(1);
    expect(store.enqueueJob).toHaveBeenCalledWith("audit_hacker_backfill", expect.any(Object), 2);
  });
});

describe("scheduleDownstreamCrawl", () => {
  it("skips all cron enqueue when rebuild is active", async () => {
    const store = mockStore({
      countActiveJobs: vi.fn().mockResolvedValue(5),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qhack", liveBalanceAt: null }]),
      getSourceSync: vi.fn().mockResolvedValue(null),
      getSyncState: vi.fn().mockResolvedValue(null),
      getDownstreamFrontier: vi.fn().mockResolvedValue([{ address: "bc1qdown" }]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([{ address: "bc1qdown2" }]),
    });

    await scheduleDownstreamCrawl(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});

describe("scheduleBtcUsdPriceRefresh", () => {
  it("enqueues refresh when no price is stored", async () => {
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue(null),
    });

    await scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "refresh_btc_usd_price",
      {},
      JOB_PRIORITY.REFRESH_BTC_USD,
    );
  });

  it("enqueues refresh when price is stale", async () => {
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue({ usd: 64000, at: staleAt }),
    });

    await scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "refresh_btc_usd_price",
      {},
      JOB_PRIORITY.REFRESH_BTC_USD,
    );
  });

  it("skips when price is fresh", async () => {
    const freshAt = new Date().toISOString();
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue({ usd: 64000, at: freshAt }),
    });

    await scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("skips when refresh job is already pending", async () => {
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue(null),
      hasPendingJob: vi.fn().mockImplementation(async (type: string) => type === "refresh_btc_usd_price"),
    });

    await scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});
