import { describe, expect, it, vi } from "vitest";
import type { Job, Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import type { AppConfig } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { RateLimitNotReadyError } from "../chain/router.js";
import { processJobs } from "./processor.js";

function baseConfig(): AppConfig {
  return {
    databaseUrl: "file:./test.db",
    esploraBase: "https://blockstream.info/api",
    mempoolBase: "https://mempool.space/api",
    rateLimitMs: 3000,
    jobsPerTick: 2,
    jobsPerTickMax: 2,
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
    backfillTxsPerJob: 1,
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
    jobCpuGuardMs: 0,
    recentHackersLimit: 5,
    hackersPollMs: 3_600_000,
    queueDepthPerExtraJob: 40,
    queueDrainFirstDepth: 1,
    queueSoftThrottleDepth: 80,
  };
}

function makeJob(
  overrides: Partial<Job> & Pick<Job, "type" | "payloadJson">,
): Job {
  return {
    id: 1,
    status: "running",
    priority: JOB_PRIORITY.BACKFILL_HACKER,
    runAfter: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    reclaimCount: 0,
    reclaimProgressJson: null,
    ...overrides,
  };
}

describe("processJobs weight-aware pairing", () => {
  it("pair_wait after heavy ingest when no process-only candidate on slot 1", async () => {
    const auditJob = makeJob({
      id: 10,
      type: "audit_hacker_backfill",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
    });
    const heavyBackfill = makeJob({
      id: 20,
      type: "backfill_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qother" }),
    });
    const pacingAt = new Date(Date.now() + 8_000).toISOString();

    const claimIngestJobById = vi.fn().mockResolvedValueOnce(auditJob);
    const completeJob = vi.fn();
    const listPendingIngestCandidates = vi
      .fn()
      .mockResolvedValueOnce([auditJob])
      .mockResolvedValueOnce([heavyBackfill]);

    const store = {
      listPendingIngestCandidates,
      claimIngestJobById,
      claimNextJob: vi.fn(),
      completeJob,
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(2),
      canUseSubrequests: vi.fn().mockReturnValue(true),
      getSchedulerState: vi.fn().mockResolvedValue({ nextProviderCallAt: pacingAt }),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qhack" }]),
      countIndexedTxsForHacker: vi.fn().mockResolvedValue(1),
      updateBackfillAudit: vi.fn(),
      upsertBackfillState: vi.fn(),
      getBackfillState: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressStats: () => Promise<unknown> }) => unknown) =>
        fn({
          getAddressStats: async () => ({ chain_stats: { tx_count: 1 } }),
        }),
      ),
    } as unknown as ChainRouter;

    const { processed, stopReason } = await processJobs(store, router, {
      ...baseConfig(),
      jobsPerTick: 2,
    });

    expect(processed).toBe(1);
    expect(stopReason).toBe("pair_wait");
    expect(completeJob).toHaveBeenCalledWith(auditJob.id);
    expect(claimIngestJobById).toHaveBeenCalledTimes(1);
  });

  it("uses stop=pacing when RateLimitNotReadyError stops tick", async () => {
    const pollJob = makeJob({
      id: 20,
      type: "poll_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
      priority: JOB_PRIORITY.POLL_HACKER,
    });
    const retryAt = new Date(Date.now() + 8_000).toISOString();

    const store = {
      listPendingIngestCandidates: vi.fn().mockResolvedValue([]),
      claimIngestJobById: vi.fn(),
      claimNextJob: vi.fn().mockResolvedValue(pollJob),
      failJob: vi.fn(),
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(1),
      canUseSubrequests: vi.fn().mockReturnValue(true),
      getSchedulerState: vi.fn().mockResolvedValue({}),
      getSyncState: vi.fn().mockResolvedValue(null),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qhack" }]),
      touchSyncPoll: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn().mockRejectedValue(new RateLimitNotReadyError(retryAt, "pacing")),
    } as unknown as ChainRouter;

    const { processed, stopReason } = await processJobs(store, router, baseConfig());

    expect(processed).toBe(0);
    expect(stopReason).toBe("pacing");
  });
});
