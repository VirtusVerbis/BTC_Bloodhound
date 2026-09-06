import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { processJob } from "./processor.js";

function baseConfig(): AppConfig {
  return {
    databaseUrl: "file:./test.db",
    esploraBase: "https://blockstream.info/api",
    mempoolBase: "https://mempool.space/api",
    chainPrimaryProvider: "esplora",
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
    maxChainCallsPerJob: 1,
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
    opReturnBackfillPerJob: 3,
    opReturnBackfillEveryNCrons: 10,
  } as AppConfig;
}

describe("backfill_op_return job", () => {
  it("re-enqueues when backlog remains", async () => {
    const enqueueJobIfAbsent = vi.fn().mockResolvedValue(99);
    const listTxidsMissingOpReturn = vi
      .fn()
      .mockResolvedValueOnce(["tx1", "tx2"])
      .mockResolvedValueOnce(["tx2"]);
    const countTransactionsMissingOpReturn = vi.fn().mockResolvedValue(1);
    const upsertTransaction = vi.fn();
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const store = {
      listTxidsMissingOpReturn,
      countTransactionsMissingOpReturn,
      enqueueJobIfAbsent,
      getTransaction,
      upsertTransaction,
      flushRecentHackerActivity: vi.fn(),
    } as unknown as Store;

    const getTx = vi.fn().mockResolvedValue({
      txid: "tx1",
      vin: [],
      vout: [{ scriptpubkey_address: "bc1q", value: 1 }],
    });
    const router = {
      withProvider: vi.fn(async (fn: (p: { getTx: typeof getTx }) => Promise<unknown>) =>
        fn({ getTx }),
      ),
    } as unknown as ChainRouter;

    const job = {
      id: 1,
      type: "backfill_op_return",
      payloadJson: "{}",
      status: "running",
      priority: JOB_PRIORITY.REFRESH_BALANCE,
      runAfter: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      reclaimCount: 0,
      reclaimProgressJson: null,
    };

    await processJob(store, router, baseConfig(), job);

    expect(getTx).toHaveBeenCalledTimes(1);
    expect(enqueueJobIfAbsent).toHaveBeenCalledWith(
      "backfill_op_return",
      {},
      JOB_PRIORITY.REFRESH_BALANCE,
      undefined,
      { dedupeTypes: ["backfill_op_return"] },
    );
  });
});
