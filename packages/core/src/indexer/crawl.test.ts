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
    indexerRebuildMode: false,
    processTxRebuildPriority: JOB_PRIORITY.PROCESS_TX_REBUILD,
  };
}

function mockStore(overrides: Partial<Store> = {}): Store {
  return {
    listHackers: vi.fn().mockReturnValue([]),
    hasPendingJob: vi.fn().mockReturnValue(false),
    countActiveJobs: vi.fn().mockReturnValue(0),
    getAddress: vi.fn(),
    getBackfillState: vi.fn(),
    enqueueJob: vi.fn(),
    getBackfillHealAuditIndex: vi.fn().mockReturnValue(0),
    setBackfillHealAuditIndex: vi.fn(),
    getBtcUsdPrice: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as Store;
}

describe("scheduleHackerBackfillHeal", () => {
  it("enqueues backfill when hacker is backfilling and no job exists", () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockReturnValue([{ address: addr }]),
      getAddress: vi.fn().mockReturnValue({ address: addr, expandStatus: "backfilling" }),
      getBackfillState: vi.fn().mockReturnValue({
        payload: { chainCursor: "txabc", pagesExhausted: false },
        backfillComplete: false,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      expect.objectContaining({ address: addr, chainCursor: "txabc" }),
      2,
    );
  });

  it("enqueues backfill when expanded but backfill_complete is false", () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockReturnValue([{ address: addr }]),
      getAddress: vi.fn().mockReturnValue({ address: addr, expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockReturnValue({
        payload: null,
        backfillComplete: false,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      { address: addr },
      2,
    );
  });

  it("enqueues audit when expanded, complete, and audit is due", () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockReturnValue([{ address: addr }]),
      getAddress: vi.fn().mockReturnValue({ address: addr, expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockReturnValue({
        payload: null,
        backfillComplete: true,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith("audit_hacker_backfill", { address: addr }, 2);
  });

  it("skips when backfill job is already pending", () => {
    const addr = "bc1qhack";
    const store = mockStore({
      listHackers: vi.fn().mockReturnValue([{ address: addr }]),
      hasPendingJob: vi.fn().mockImplementation((type: string) => type === "backfill_hacker_address"),
      getAddress: vi.fn().mockReturnValue({ address: addr, expandStatus: "backfilling" }),
    });

    scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("respects audit per cron cap", () => {
    const hackers = [
      { address: "bc1qa" },
      { address: "bc1qb" },
      { address: "bc1qc" },
    ];
    const store = mockStore({
      listHackers: vi.fn().mockReturnValue(hackers),
      getAddress: vi.fn().mockReturnValue({ expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockReturnValue({
        payload: null,
        backfillComplete: true,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    scheduleHackerBackfillHeal(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledTimes(1);
    expect(store.enqueueJob).toHaveBeenCalledWith("audit_hacker_backfill", expect.any(Object), 2);
  });
});

describe("scheduleDownstreamCrawl", () => {
  it("skips all cron enqueue when rebuild is active", () => {
    const store = mockStore({
      countActiveJobs: vi.fn().mockReturnValue(5),
      listHackers: vi.fn().mockReturnValue([{ address: "bc1qhack", liveBalanceAt: null }]),
      getSourceSync: vi.fn().mockReturnValue(null),
      getSyncState: vi.fn().mockReturnValue(null),
      getDownstreamFrontier: vi.fn().mockReturnValue([{ address: "bc1qdown" }]),
      listDownstreamForPoll: vi.fn().mockReturnValue([{ address: "bc1qdown2" }]),
    });

    scheduleDownstreamCrawl(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});

describe("scheduleBtcUsdPriceRefresh", () => {
  it("enqueues refresh when no price is stored", () => {
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockReturnValue(null),
    });

    scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "refresh_btc_usd_price",
      {},
      JOB_PRIORITY.REFRESH_BTC_USD,
    );
  });

  it("enqueues refresh when price is stale", () => {
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockReturnValue({ usd: 64000, at: staleAt }),
    });

    scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).toHaveBeenCalledWith(
      "refresh_btc_usd_price",
      {},
      JOB_PRIORITY.REFRESH_BTC_USD,
    );
  });

  it("skips when price is fresh", () => {
    const freshAt = new Date().toISOString();
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockReturnValue({ usd: 64000, at: freshAt }),
    });

    scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("skips when refresh job is already pending", () => {
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockReturnValue(null),
      hasPendingJob: vi.fn().mockImplementation((type: string) => type === "refresh_btc_usd_price"),
    });

    scheduleBtcUsdPriceRefresh(store, baseConfig());

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});
