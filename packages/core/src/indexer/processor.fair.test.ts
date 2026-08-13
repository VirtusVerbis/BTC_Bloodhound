import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Job, Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { RateLimitHttpError } from "../chain/esplora.js";
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

describe("processJobs fair scheduling", () => {
  it("claims ingest job before higher-priority poll when both pending", async () => {
    const auditJob = makeJob({
      id: 10,
      type: "audit_hacker_backfill",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
      priority: JOB_PRIORITY.BACKFILL_HACKER,
    });

    const claimNextIngestJob = vi.fn().mockResolvedValue(auditJob);
    const claimNextJob = vi.fn().mockResolvedValue(
      makeJob({
        id: 20,
        type: "poll_hacker_address",
        payloadJson: JSON.stringify({ address: "bc1qhack" }),
        priority: JOB_PRIORITY.POLL_HACKER,
      }),
    );
    const completeJob = vi.fn();

    const store = {
      claimNextIngestJob,
      claimNextJob,
      completeJob,
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(0),
      countIndexedTxsForHacker: vi.fn().mockResolvedValue(100),
      updateBackfillAudit: vi.fn(),
      upsertBackfillState: vi.fn(),
      getBackfillState: vi.fn(),
      enqueueJob: vi.fn(),
      setExpandStatus: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressStats: () => Promise<unknown> }) => unknown) =>
        fn({
          getAddressStats: async () => ({ chain_stats: { tx_count: 100 } }),
        }),
      ),
    } as unknown as ChainRouter;

    const n = await processJobs(store, router, baseConfig());

    expect(n).toBe(1);
    expect(claimNextIngestJob).toHaveBeenCalledWith({ preferContinuation: true });
    expect(claimNextJob).not.toHaveBeenCalled();
    expect(completeJob).toHaveBeenCalledWith(auditJob.id);
  });

  it("falls back to claimNextJob when no ingest jobs pending", async () => {
    const pollJob = makeJob({
      id: 20,
      type: "poll_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
      priority: JOB_PRIORITY.POLL_HACKER,
    });

    const claimNextIngestJob = vi.fn().mockResolvedValue(null);
    const claimNextJob = vi.fn().mockResolvedValue(pollJob);
    const completeJob = vi.fn();

    const store = {
      claimNextIngestJob,
      claimNextJob,
      completeJob,
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(0),
      getSyncState: vi.fn().mockResolvedValue(null),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qhack" }]),
      touchSyncPoll: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressTxs: () => Promise<[]> }) => unknown) =>
        fn({ getAddressTxs: async () => [] }),
      ),
    } as unknown as ChainRouter;

    const n = await processJobs(store, router, baseConfig());

    expect(n).toBe(1);
    expect(claimNextJob).toHaveBeenCalled();
    expect(completeJob).toHaveBeenCalledWith(pollJob.id);
    expect(store.touchSyncPoll).toHaveBeenCalledWith("bc1qhack");
  });

  it("stops claiming when deadlineMs has passed", async () => {
    const claimNextIngestJob = vi.fn().mockResolvedValue(null);
    const claimNextJob = vi.fn();
    const store = {
      claimNextIngestJob,
      claimNextJob,
    } as unknown as Store;
    const router = {} as unknown as ChainRouter;

    const n = await processJobs(store, router, { ...baseConfig(), jobsPerTick: 5 }, { deadlineMs: Date.now() - 1 });

    expect(n).toBe(0);
    expect(claimNextIngestJob).not.toHaveBeenCalled();
    expect(claimNextJob).not.toHaveBeenCalled();
  });

  it("fails job with provider retryAt on HTTP 429", async () => {
    const pollJob = makeJob({
      id: 20,
      type: "poll_hacker_address",
      payloadJson: JSON.stringify({ address: "bc1qhack" }),
      priority: JOB_PRIORITY.POLL_HACKER,
    });
    const providerRetryAt = new Date(Date.now() + 300_000).toISOString();

    const completeJob = vi.fn();
    const failJob = vi.fn();
    const store = {
      claimNextIngestJob: vi.fn().mockResolvedValue(null),
      claimNextJob: vi.fn().mockResolvedValue(pollJob),
      completeJob,
      failJob,
      maybeClearQueueSchedulingPause: vi.fn(),
      getQueueDepth: vi.fn().mockResolvedValue(1),
      earliestProviderRetryAt: vi.fn().mockResolvedValue(providerRetryAt),
      getSyncState: vi.fn().mockResolvedValue(null),
      listHackers: vi.fn().mockResolvedValue([{ address: "bc1qhack" }]),
      touchSyncPoll: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn().mockRejectedValue(new RateLimitHttpError("429 Too Many Requests", 300)),
    } as unknown as ChainRouter;

    const n = await processJobs(store, router, baseConfig());

    expect(n).toBe(0);
    expect(failJob).toHaveBeenCalledWith(pollJob.id, "429 Too Many Requests", providerRetryAt);
    expect(completeJob).not.toHaveBeenCalled();
  });
});
