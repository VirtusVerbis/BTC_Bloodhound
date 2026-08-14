import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Job, Store } from "@cointrace/db";
import { RateLimitNotReadyError } from "../chain/router.js";
import { handleJobFailure } from "./processor.js";

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
    subrequestLimitPerInvocation: 0,
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

function makeJob(overrides: Partial<Job> & Pick<Job, "type">): Job {
  return {
    id: 17354,
    status: "running",
    priority: JOB_PRIORITY.BACKFILL_HACKER,
    payloadJson: JSON.stringify({
      address: "bc1qtest",
      chainCursor: "abc123",
      pendingTxids: [],
      processedIndex: 0,
    }),
    runAfter: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe("handleJobFailure defer", () => {
  it("failJob with short retry when ingest attempt is below threshold", async () => {
    const retryAt = new Date(Date.now() + 10_000).toISOString();
    const err = new RateLimitNotReadyError(retryAt, "pacing");
    const failJob = vi.fn();
    const deferJob = vi.fn();
    const store = { failJob, deferJob } as unknown as Store;
    const job = makeJob({ type: "backfill_hacker_address", attempts: 18 });

    const stop = await handleJobFailure(store, baseConfig(), job, err);

    expect(stop).toBe(true);
    expect(failJob).toHaveBeenCalledWith(job.id, err.message, retryAt);
    expect(deferJob).not.toHaveBeenCalled();
  });

  it("deferJob when ingest attempt reaches threshold", async () => {
    const retryAt = new Date(Date.now() + 10_000).toISOString();
    const err = new RateLimitNotReadyError(retryAt, "pacing");
    const failJob = vi.fn();
    const deferJob = vi.fn();
    const store = { failJob, deferJob } as unknown as Store;
    const job = makeJob({ type: "backfill_hacker_address", attempts: 19 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const before = Date.now();
    const stop = await handleJobFailure(store, baseConfig(), job, err);
    const after = Date.now();

    expect(stop).toBe(true);
    expect(failJob).not.toHaveBeenCalled();
    expect(deferJob).toHaveBeenCalledTimes(1);
    const [id, message, runAfter] = deferJob.mock.calls[0]!;
    expect(id).toBe(job.id);
    expect(message).toBe(err.message);
    const runAfterMs = new Date(runAfter as string).getTime();
    expect(runAfterMs).toBeGreaterThanOrEqual(before + 86400 * 1000 - 100);
    expect(runAfterMs).toBeLessThanOrEqual(after + 86400 * 1000 + 100);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("attempts=20"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[job] defer id=17354"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("deferSec=86400"));

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("failJob for non-ingest job even above threshold", async () => {
    const retryAt = new Date(Date.now() + 10_000).toISOString();
    const err = new RateLimitNotReadyError(retryAt, "pacing");
    const failJob = vi.fn();
    const deferJob = vi.fn();
    const store = { failJob, deferJob } as unknown as Store;
    const job = makeJob({ type: "poll_hacker_address", attempts: 49 });

    await handleJobFailure(store, baseConfig(), job, err);

    expect(failJob).toHaveBeenCalledWith(job.id, err.message, retryAt);
    expect(deferJob).not.toHaveBeenCalled();
  });
});
