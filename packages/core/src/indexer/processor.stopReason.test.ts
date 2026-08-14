import { describe, expect, it, vi } from "vitest";
import type { Job, Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import type { AppConfig } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { processJobs } from "./processor.js";
import { createSubrequestBudget } from "./subrequestBudget.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    subrequestLimitPerInvocation: 50,
    scheduleSubrequestReserve: 38,
    scheduleReserveMaintExtra: 10,
    maxSubrequestsPerJob: 0,
    maxEdgesPerJob: 0,
    maxGraphEdgesPerTx: 0,
    d1BatchSize: 8,
    syncAddressesPerJob: 5,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> & Pick<Job, "type" | "payloadJson">): Job {
  return {
    id: 1,
    status: "running",
    priority: JOB_PRIORITY.POLL_HACKER,
    runAfter: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("processJobs stopReason", () => {
  it("returns idle when no jobs are claimable", async () => {
    const budget = createSubrequestBudget(50);
    const store = {
      claimNextIngestJob: vi.fn().mockResolvedValue(null),
      claimNextJob: vi.fn().mockResolvedValue(null),
      canUseSubrequests: vi.fn().mockReturnValue(true),
    } as unknown as Store;

    const result = await processJobs(store, {} as ChainRouter, baseConfig(), {
      subrequestBudget: budget,
    });

    expect(result).toEqual({ processed: 0, stopReason: "idle" });
  });

  it("returns subreq when budget is exhausted before claim", async () => {
    const budget = createSubrequestBudget(50);
    budget.consume(49);
    const store = {
      claimNextIngestJob: vi.fn(),
      claimNextJob: vi.fn(),
      canUseSubrequests: vi.fn().mockReturnValue(true),
    } as unknown as Store;

    const result = await processJobs(store, {} as ChainRouter, baseConfig(), {
      subrequestBudget: budget,
    });

    expect(result).toEqual({ processed: 0, stopReason: "subreq" });
    expect(store.claimNextIngestJob).not.toHaveBeenCalled();
  });

  it("returns jobs_cap after processing jobsPerTick jobs", async () => {
    const budget = createSubrequestBudget(50);
    const pollJob = makeJob({
      id: 20,
      type: "poll_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
    });
    let calls = 0;
    const store = {
      claimNextIngestJob: vi.fn().mockResolvedValue(null),
      claimNextJob: vi.fn().mockImplementation(async () => {
        calls++;
        return calls <= 2 ? pollJob : null;
      }),
      completeJob: vi.fn(),
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(1),
      getSyncState: vi.fn().mockResolvedValue(null),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qhack" }]),
      touchSyncPoll: vi.fn(),
      canUseSubrequests: vi.fn().mockReturnValue(true),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressTxs: () => Promise<[]> }) => unknown) =>
        fn({ getAddressTxs: async () => [] }),
      ),
    } as unknown as ChainRouter;

    const result = await processJobs(store, router, { ...baseConfig(), jobsPerTick: 2 }, {
      subrequestBudget: budget,
    });

    expect(result).toEqual({ processed: 2, stopReason: "jobs_cap" });
  });

  it("stops claiming jobs when store subrequest sink is exhausted", async () => {
    const budget = createSubrequestBudget(50);
    budget.consume(48);
    const store = {
      claimNextIngestJob: vi.fn(),
      claimNextJob: vi.fn(),
      canUseSubrequests: vi.fn().mockReturnValue(false),
    } as unknown as Store;

    const result = await processJobs(store, {} as ChainRouter, baseConfig(), {
      subrequestBudget: budget,
    });

    expect(result).toEqual({ processed: 0, stopReason: "subreq" });
    expect(store.claimNextJob).not.toHaveBeenCalled();
  });
});
