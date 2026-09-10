import { describe, expect, it, vi } from "vitest";
import { processJob } from "./processor.js";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Job, Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";

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
    minExpandSats: 100_000,
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

describe("poll_downstream_address min expand abort", () => {
  it("returns without chain fetch or continuation when inbound is below the floor", async () => {
    const address = "bc1qdust";
    const store = {
      getDownstreamExpandContext: vi.fn().mockResolvedValue(
        new Map([[address, { expandStatus: "expanded", inboundSats: 1_000 }]]),
      ),
      getAddress: vi.fn(),
      getSyncState: vi.fn(),
      enqueueJob: vi.fn(),
      touchSyncPoll: vi.fn(),
      flushRecentHackerActivity: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(),
    } as unknown as ChainRouter;

    const job = {
      id: 1,
      type: "poll_downstream_address",
      payloadJson: JSON.stringify({
        address,
        pollFetched: true,
        pendingTxids: ["tx-pending"],
        processedIndex: 0,
      }),
      status: "running",
      priority: JOB_PRIORITY.POLL_DOWNSTREAM,
      runAfter: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    } as Job;

    await processJob(store, router, baseConfig(), job);

    expect(store.getDownstreamExpandContext).toHaveBeenCalledWith([address]);
    expect(router.withProvider).not.toHaveBeenCalled();
    expect(store.enqueueJob).not.toHaveBeenCalled();
    expect(store.touchSyncPoll).not.toHaveBeenCalled();
    expect(store.getAddress).not.toHaveBeenCalled();
  });
});
