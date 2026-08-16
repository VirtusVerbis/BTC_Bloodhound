import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  maintainOneHacker,
  scheduleBtcUsdPriceRefresh,
  scheduleDownstreamCrawl,
} from "./crawl.js";
import { JOB_PRIORITY } from "../config.js";
import type { AppConfig } from "../config.js";
import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { fetchMempoolBtcUsd } from "../price/mempoolPrices.js";
import { createUnlimitedSubrequestBudget } from "./subrequestBudget.js";

vi.mock("../price/mempoolPrices.js", () => ({
  fetchMempoolBtcUsd: vi.fn(),
}));

const unlimitedBudget = createUnlimitedSubrequestBudget();
const mockRouter = {} as ChainRouter;

const BACKFILL_DEDUPE = {
  dedupeTypes: ["backfill_hacker_address", "audit_hacker_backfill"],
};

function baseConfig(): AppConfig {
  return {
    databaseUrl: "file:./test.db",
    esploraBase: "https://blockstream.info/api",
    mempoolBase: "https://mempool.space/api",
    rateLimitMs: 3000,
    jobsPerTick: 1,
    tickBudgetMs: 50_000,
    runningJobStaleMs: 120_000,
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
    apiThresholdBaseSec: 300,
    apiThresholdMaxSec: 3600,
    backfillTxsPerJob: 5,
    maxChainCallsPerJob: 0,
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
    graphContinuationRateLimit: 120,
    graphPageSizeDefault: 500,
    graphPageSizeMax: 1000,
    maxGraphVictims: 1000,
    maxGraphDownstream: 1000,
    maxQueueDepth: 360,
    queueDrainFirstDepth: 1,
    jobsPerTickMax: 3,
    queueDepthPerExtraJob: 40,
    queueSoftThrottleDepth: 80,
    indexerJobDetails: false,
    indexerLogColor: false,
    jobDeferAfterAttempts: 20,
    jobDeferSec: 86400,
    subrequestLimitPerInvocation: 0,
    scheduleSubrequestReserve: 38,
    scheduleReserveMaintExtra: 10,
    maxSubrequestsPerJob: 0,
    maxEdgesPerJob: 0,
    maxGraphEdgesPerTx: 0,
    d1BatchSize: 8,
    syncAddressesPerJob: 5,
  };
}

function mockStore(overrides: Partial<Store> = {}): Store {
  return {
    listHackers: vi.fn().mockResolvedValue([]),
    hasPendingJob: vi.fn().mockResolvedValue(false),
    countActiveJobs: vi.fn().mockResolvedValue(0),
    getAddress: vi.fn(),
    getBackfillState: vi.fn(),
    getSyncState: vi.fn(),
    enqueueJob: vi.fn(),
    enqueueJobIfAbsent: vi.fn().mockResolvedValue(1),
    claimNextHackerPollIndex: vi.fn().mockResolvedValue(0),
    incrementMaintenanceCronCounter: vi.fn().mockResolvedValue(10),
    getBtcUsdPrice: vi.fn().mockResolvedValue(null),
    getSchedulerState: vi.fn().mockResolvedValue(null),
    getQueueDepth: vi.fn().mockResolvedValue(0),
    getSourceSync: vi.fn().mockResolvedValue(null),
    getDownstreamFrontier: vi.fn().mockResolvedValue([]),
    listDownstreamForPoll: vi.fn().mockResolvedValue([]),
    setExpandStatus: vi.fn().mockResolvedValue(undefined),
    setBtcUsdRefreshAttemptAt: vi.fn().mockResolvedValue(undefined),
    setBtcUsdPrice: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Store;
}

describe("maintainOneHacker", () => {
  const ts = Date.now();

  it("enqueues backfill when hacker is backfilling and no job exists", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "backfilling" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: { chainCursor: "txabc", pagesExhausted: false },
        backfillComplete: false,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await maintainOneHacker(store, baseConfig(), { address: addr }, ts);

    expect(store.enqueueJobIfAbsent).toHaveBeenCalledWith(
      "backfill_hacker_address",
      expect.objectContaining({ address: addr, chainCursor: "txabc" }),
      JOB_PRIORITY.BACKFILL_HACKER,
      undefined,
      expect.objectContaining({ ...BACKFILL_DEDUPE, address: addr }),
    );
  });

  it("enqueues backfill when expanded but backfill_complete is false", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: null,
        backfillComplete: false,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await maintainOneHacker(store, baseConfig(), { address: addr }, ts);

    expect(store.enqueueJobIfAbsent).toHaveBeenCalledWith(
      "backfill_hacker_address",
      { address: addr },
      JOB_PRIORITY.BACKFILL_HACKER,
      undefined,
      expect.objectContaining({ ...BACKFILL_DEDUPE, address: addr }),
    );
  });

  it("enqueues audit when expanded, complete, and audit is due", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "expanded" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: null,
        backfillComplete: true,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await maintainOneHacker(store, baseConfig(), { address: addr }, ts);

    expect(store.enqueueJobIfAbsent).toHaveBeenCalledWith(
      "audit_hacker_backfill",
      { address: addr },
      JOB_PRIORITY.BACKFILL_HACKER,
      undefined,
      expect.objectContaining({ ...BACKFILL_DEDUPE, address: addr }),
    );
  });

  it("calls atomic enqueue for backfilling hacker even when duplicate would be skipped", async () => {
    const addr = "bc1qhack";
    const store = mockStore({
      enqueueJobIfAbsent: vi.fn().mockResolvedValue(null),
      getAddress: vi.fn().mockResolvedValue({ address: addr, expandStatus: "backfilling" }),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: { chainCursor: "txabc", pagesExhausted: false },
        backfillComplete: false,
        lastBackfillAuditAt: null,
        chainTxCountAtAudit: null,
      }),
    });

    await maintainOneHacker(
      store,
      baseConfig(),
      { address: addr, liveBalanceAt: new Date().toISOString() },
      ts,
    );

    expect(store.enqueueJobIfAbsent).toHaveBeenCalledWith(
      "backfill_hacker_address",
      expect.objectContaining({ address: addr }),
      JOB_PRIORITY.BACKFILL_HACKER,
      undefined,
      expect.objectContaining({ ...BACKFILL_DEDUPE, address: addr }),
    );
  });
});

describe("scheduleDownstreamCrawl", () => {
  it("skips all cron enqueue when rebuild is active", async () => {
    const store = mockStore({
      countActiveJobs: vi.fn().mockResolvedValue(5),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qhack", liveBalanceAt: null }]),
      getSourceSync: vi.fn().mockResolvedValue(null),
      getDownstreamFrontier: vi.fn().mockResolvedValue([{ address: "bc1qdown" }]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([{ address: "bc1qdown2" }]),
    });

    await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    expect(store.enqueueJobIfAbsent).not.toHaveBeenCalled();
  });

  it("skips hacker maintenance when counter is not divisible by stride", async () => {
    const store = mockStore({
      incrementMaintenanceCronCounter: vi.fn().mockResolvedValue(7),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qa" }]),
      getSourceSync: vi.fn().mockResolvedValue({ lastSyncAt: new Date().toISOString() }),
      getDownstreamFrontier: vi.fn().mockResolvedValue([]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([]),
    });

    await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    expect(store.listHackers).not.toHaveBeenCalled();
  });

  it("skips poll when backfill is not complete on maintenance tick", async () => {
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qa" }]),
      getBackfillState: vi.fn().mockResolvedValue({ backfillComplete: false }),
      getSourceSync: vi.fn().mockResolvedValue({ lastSyncAt: new Date().toISOString() }),
      claimNextHackerPollIndex: vi.fn().mockResolvedValue(0),
      getDownstreamFrontier: vi.fn().mockResolvedValue([]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([]),
    });

    await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    expect(store.enqueueJobIfAbsent).not.toHaveBeenCalledWith(
      "poll_hacker_address",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("maintains exactly one hacker per maintenance tick", async () => {
    const hackers = [{ address: "bc1qa" }, { address: "bc1qb" }, { address: "bc1qc" }];
    const getBackfillState = vi.fn().mockResolvedValue({ backfillComplete: true });
    const getSyncState = vi.fn().mockResolvedValue(null);
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue(hackers),
      getBackfillState,
      getSyncState,
      getSourceSync: vi.fn().mockResolvedValue({ lastSyncAt: new Date().toISOString() }),
      claimNextHackerPollIndex: vi.fn().mockResolvedValue(0),
      getDownstreamFrontier: vi.fn().mockResolvedValue([]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([]),
    });

    await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    const pollCalls = (store.enqueueJobIfAbsent as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "poll_hacker_address",
    );
    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]![1]).toEqual({ address: "bc1qa" });
    expect(store.claimNextHackerPollIndex).toHaveBeenCalledWith(3);
    expect(getBackfillState).toHaveBeenCalledWith("bc1qa");
    expect(getBackfillState).not.toHaveBeenCalledWith("bc1qb");
    expect(getBackfillState).not.toHaveBeenCalledWith("bc1qc");
  });

  it("round-robins maintenance starting from hacker_poll_index", async () => {
    const hackers = [{ address: "bc1qa" }, { address: "bc1qb" }];
    const store = mockStore({
      listHackers: vi.fn().mockResolvedValue(hackers),
      getBackfillState: vi.fn().mockResolvedValue({ backfillComplete: true }),
      getSyncState: vi.fn().mockResolvedValue(null),
      getSourceSync: vi.fn().mockResolvedValue({ lastSyncAt: new Date().toISOString() }),
      claimNextHackerPollIndex: vi.fn().mockResolvedValue(1),
      getDownstreamFrontier: vi.fn().mockResolvedValue([]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([]),
    });

    await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    expect(store.enqueueJobIfAbsent).toHaveBeenCalledWith(
      "poll_hacker_address",
      { address: "bc1qb" },
      JOB_PRIORITY.POLL_HACKER,
      undefined,
      { address: "bc1qb" },
    );
    expect(store.claimNextHackerPollIndex).toHaveBeenCalledWith(2);
  });

  it("enqueues backfill heal for backfilling hacker on maintenance tick", async () => {
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
      getSourceSync: vi.fn().mockResolvedValue({ lastSyncAt: new Date().toISOString() }),
      claimNextHackerPollIndex: vi.fn().mockResolvedValue(0),
      getDownstreamFrontier: vi.fn().mockResolvedValue([]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([]),
    });

    await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    expect(store.enqueueJobIfAbsent).toHaveBeenCalledWith(
      "backfill_hacker_address",
      expect.objectContaining({ address: addr, chainCursor: "txabc" }),
      JOB_PRIORITY.BACKFILL_HACKER,
      undefined,
      expect.objectContaining({ ...BACKFILL_DEDUPE, address: addr }),
    );
  });

  it("skips crawl and poll enqueue when queue depth is at soft throttle threshold", async () => {
    const store = mockStore({
      getQueueDepth: vi.fn().mockResolvedValue(80),
      getSchedulerState: vi.fn().mockResolvedValue({ queueSchedulingPaused: 0 }),
      incrementMaintenanceCronCounter: vi.fn().mockResolvedValue(10),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qa" }]),
      getBackfillState: vi.fn().mockResolvedValue({ backfillComplete: true }),
      getSyncState: vi.fn().mockResolvedValue(null),
      getSourceSync: vi.fn().mockResolvedValue({ lastSyncAt: new Date().toISOString() }),
      getDownstreamFrontier: vi.fn().mockResolvedValue([{ address: "bc1qdown" }]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([{ address: "bc1qdown2" }]),
    });

    const stats = await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    expect(stats.throttled).toBe(true);
    expect(stats.crawlEnqueued).toBe(0);
    expect(stats.pollEnqueued).toBe(0);
    expect(store.getDownstreamFrontier).not.toHaveBeenCalled();
    expect(store.listDownstreamForPoll).not.toHaveBeenCalled();
    expect(store.enqueueJobIfAbsent).toHaveBeenCalledWith(
      "poll_hacker_address",
      { address: "bc1qa" },
      JOB_PRIORITY.POLL_HACKER,
      undefined,
      { address: "bc1qa" },
    );
  });

  it("enqueues crawl and poll when queue depth is below soft throttle threshold", async () => {
    const store = mockStore({
      getQueueDepth: vi.fn().mockResolvedValue(10),
      getSchedulerState: vi.fn().mockResolvedValue({ queueSchedulingPaused: 0 }),
      incrementMaintenanceCronCounter: vi.fn().mockResolvedValue(11),
      getSourceSync: vi.fn().mockResolvedValue({ lastSyncAt: new Date().toISOString() }),
      getDownstreamFrontier: vi.fn().mockResolvedValue([{ address: "bc1qdown" }]),
      listDownstreamForPoll: vi.fn().mockResolvedValue([{ address: "bc1qdown2" }]),
      enqueueJobIfAbsent: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2),
    });

    const stats = await scheduleDownstreamCrawl(store, baseConfig(), unlimitedBudget, 0);

    expect(stats.throttled).toBe(false);
    expect(stats.crawlEnqueued).toBe(1);
    expect(stats.pollEnqueued).toBe(1);
    expect(store.getDownstreamFrontier).toHaveBeenCalled();
    expect(store.listDownstreamForPoll).toHaveBeenCalled();
  });
});

describe("scheduleBtcUsdPriceRefresh", () => {
  beforeEach(() => {
    vi.mocked(fetchMempoolBtcUsd).mockReset();
    vi.mocked(fetchMempoolBtcUsd).mockResolvedValue({
      usd: 65000,
      at: new Date().toISOString(),
    });
  });

  it("fetches and stores when no price is stored", async () => {
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue(null),
    });

    const mode = await scheduleBtcUsdPriceRefresh(store, mockRouter, baseConfig(), unlimitedBudget, 0);

    expect(mode).toBe("inline");

    expect(store.setBtcUsdRefreshAttemptAt).toHaveBeenCalledOnce();
    expect(fetchMempoolBtcUsd).toHaveBeenCalledWith("https://mempool.space/api", store);
    expect(store.setBtcUsdPrice).toHaveBeenCalledWith(65000, expect.any(String));
    expect(store.enqueueJobIfAbsent).not.toHaveBeenCalled();
  });

  it("fetches when price is stale and no recent attempt", async () => {
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue({ usd: 64000, at: staleAt }),
      getSchedulerState: vi.fn().mockResolvedValue(null),
    });

    await scheduleBtcUsdPriceRefresh(store, mockRouter, baseConfig(), unlimitedBudget, 0);

    expect(fetchMempoolBtcUsd).toHaveBeenCalledOnce();
    expect(store.setBtcUsdPrice).toHaveBeenCalled();
  });

  it("skips when price is fresh", async () => {
    const freshAt = new Date().toISOString();
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue({ usd: 64000, at: freshAt }),
    });

    const mode = await scheduleBtcUsdPriceRefresh(store, mockRouter, baseConfig(), unlimitedBudget, 0);

    expect(mode).toBe("fresh");

    expect(fetchMempoolBtcUsd).not.toHaveBeenCalled();
    expect(store.setBtcUsdPrice).not.toHaveBeenCalled();
    expect(store.setBtcUsdRefreshAttemptAt).not.toHaveBeenCalled();
  });

  it("skips fetch when attempt is within interval (hourly gate)", async () => {
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    const recentAttempt = new Date(Date.now() - 30_000).toISOString();
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue({ usd: 64000, at: staleAt }),
      getSchedulerState: vi.fn().mockResolvedValue({ btcUsdRefreshAttemptAt: recentAttempt }),
    });

    await scheduleBtcUsdPriceRefresh(store, mockRouter, baseConfig(), unlimitedBudget, 0);

    expect(fetchMempoolBtcUsd).not.toHaveBeenCalled();
    expect(store.setBtcUsdPrice).not.toHaveBeenCalled();
    expect(store.setBtcUsdRefreshAttemptAt).not.toHaveBeenCalled();
  });

  it("keeps last price when fetch throws", async () => {
    vi.mocked(fetchMempoolBtcUsd).mockRejectedValue(new Error("network error"));
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue(null),
    });

    await scheduleBtcUsdPriceRefresh(store, mockRouter, baseConfig(), unlimitedBudget, 0);

    expect(store.setBtcUsdRefreshAttemptAt).toHaveBeenCalledOnce();
    expect(store.setBtcUsdPrice).not.toHaveBeenCalled();
  });

  it("does not retry fetch within interval after failure", async () => {
    vi.mocked(fetchMempoolBtcUsd).mockRejectedValue(new Error("network error"));
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    let attemptAt: string | null = null;
    const store = mockStore({
      getBtcUsdPrice: vi.fn().mockResolvedValue({ usd: 64000, at: staleAt }),
      getSchedulerState: vi.fn().mockImplementation(async () =>
        attemptAt ? { btcUsdRefreshAttemptAt: attemptAt } : null,
      ),
      setBtcUsdRefreshAttemptAt: vi.fn().mockImplementation(async (at: string) => {
        attemptAt = at;
      }),
    });

    await scheduleBtcUsdPriceRefresh(store, mockRouter, baseConfig(), unlimitedBudget, 0);
    await scheduleBtcUsdPriceRefresh(store, mockRouter, baseConfig(), unlimitedBudget, 0);

    expect(fetchMempoolBtcUsd).toHaveBeenCalledOnce();
    expect(store.setBtcUsdPrice).not.toHaveBeenCalled();
  });
});
