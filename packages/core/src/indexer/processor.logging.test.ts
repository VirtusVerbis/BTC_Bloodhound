import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Job, Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { processJobs } from "./processor.js";

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
    crawlEnqueuePerCron: 3,
    pollHackerEnqueuePerCron: 1,
    hackerMaintenanceEveryNCrons: 10,
    downstreamPollIntervalSec: 600,
    downstreamPollEnqueuePerCron: 2,
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
    maxGraphVictims: 1000,
    maxGraphDownstream: 1000,
    maxQueueDepth: 360,
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

function makeJob(overrides: Partial<Job> & Pick<Job, "type" | "payloadJson">): Job {
  return {
    id: 1,
    status: "running",
    priority: JOB_PRIORITY.REFRESH_BALANCE,
    runAfter: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("processJobs logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("does not emit [job] start when jobDetails is false", async () => {
    const job = makeJob({
      id: 7,
      type: "refresh_live_balance",
      payloadJson: JSON.stringify({ address: "bc1qbal" }),
    });
    const store = {
      claimNextIngestJob: vi.fn().mockResolvedValue(null),
      claimNextJob: vi.fn().mockResolvedValue(job),
      completeJob: vi.fn(),
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(0),
      upsertAddress: vi.fn(),
    } as unknown as Store;
    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressStats: () => Promise<unknown> }) => unknown) =>
        fn({
          getAddressStats: async () => ({
            chain_stats: { funded_txo_sum: 100, spent_txo_sum: 0 },
            mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
          }),
        }),
      ),
    } as unknown as ChainRouter;

    await processJobs(store, router, baseConfig(), { jobDetails: false });

    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("[job] start"))).toBe(false);
  });

  it("emits [job] start when jobDetails is true", async () => {
    const job = makeJob({
      id: 7,
      type: "refresh_live_balance",
      payloadJson: JSON.stringify({ address: "bc1qbal" }),
    });
    const store = {
      claimNextIngestJob: vi.fn().mockResolvedValue(null),
      claimNextJob: vi.fn().mockResolvedValue(job),
      completeJob: vi.fn(),
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(0),
      upsertAddress: vi.fn(),
    } as unknown as Store;
    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressStats: () => Promise<unknown> }) => unknown) =>
        fn({
          getAddressStats: async () => ({
            chain_stats: { funded_txo_sum: 100, spent_txo_sum: 0 },
            mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
          }),
        }),
      ),
    } as unknown as ChainRouter;

    await processJobs(store, router, baseConfig(), { jobDetails: true });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[job] start id=7 type=refresh_live_balance attempts=0 address=bc1qbal"),
    );
  });

  it("emits [job] fail on error even when jobDetails is false", async () => {
    const job = makeJob({
      id: 9,
      type: "refresh_live_balance",
      payloadJson: JSON.stringify({ address: "bc1qbal" }),
    });
    const store = {
      claimNextIngestJob: vi.fn().mockResolvedValue(null),
      claimNextJob: vi.fn().mockResolvedValue(job),
      completeJob: vi.fn(),
      failJob: vi.fn(),
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(1),
    } as unknown as Store;
    const router = {
      withProvider: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as ChainRouter;

    await processJobs(store, router, baseConfig(), { jobDetails: false });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[job] fail id=9 type=refresh_live_balance attempts=1 address=bc1qbal error=boom"),
    );
  });
});
