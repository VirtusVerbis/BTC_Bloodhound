import { describe, expect, it, vi } from "vitest";

vi.mock("@cointrace/core", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@cointrace/core")>();
  return {
    ...mod,
    runIndexerTick: vi.fn(async () => ({ scheduled: false, jobsProcessed: 0 })),
  };
});

import { D1RowMeter } from "@cointrace/db";
import type { Store } from "@cointrace/db";
import type { AppConfig, ChainRouter } from "@cointrace/core";
import { flushCronQuota, runCronScheduled } from "./workerCron.js";

function cronConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: "file:data/test.db",
    esploraBase: "https://example.com/esplora",
    mempoolBase: "https://example.com/mempool",
    chainPrimaryProvider: "esplora",
    rateLimitMs: 1000,
    jobsPerTick: 1,
    tickBudgetMs: 60_000,
    runningJobStaleMs: 0,
    cronIntervalSec: 60,
    crawlEnqueuePerCron: 1,
    pollHackerEnqueuePerCron: 1,
    pollDownstreamEnqueuePerCron: 1,
    maxCrawlDepth: 3,
    downstreamPollIntervalSec: 3600,
    minExpandSats: 0,
    maxQueueDepth: 360,
    queueSchedulingResumeDepth: 180,
    maxPendingExpandPerAddress: 2,
    maxPendingExpandGlobal: 40,
    maxPendingBackfillGlobal: 3,
    maxPendingAuditGlobal: 1,
    d1BatchSize: 8,
    environment: "test",
    corsOrigins: [],
    minEdgeSats: 0,
    maxGraphDepth: 3,
    maxGraphVictims: 100,
    maxGraphDownstream: 100,
    graphPageSizeDefault: 50,
    graphPageSizeMax: 100,
    graphBundleMinEdges: 2,
    graphRateLimit: 100,
    graphContinuationRateLimit: 100,
    graphRateWindowSec: 60,
    getRateLimit: 100,
    getRateWindowSec: 60,
    recentHackersLimit: 10,
    btcUsdPriceRefreshIntervalSec: 300,
    monitoringStaleSec: 300,
    apiThresholdCooldownSec: 60,
    apiThresholdBaseSec: 60,
    apiThresholdMaxSec: 3600,
    jobPruneEnabled: true,
    jobDoneRetentionDays: 7,
    jobPruneIntervalDays: 1,
    rateLimitPruneInactiveDays: 7,
    spendFanoutTopK: 5,
    maxChainCallsPerJob: 10,
    subrequestLimitPerInvocation: 0,
    scheduleSubrequestReserve: 0,
    scheduleReserveMaintExtra: 0,
    hackerMaintenanceEveryNCrons: 0,
    jobReclaimDeferAfter: 0,
    jobReclaimDeferSec: 0,
    indexerJobDetails: false,
    indexerLogColor: false,
    indexerLogColorMode: "auto",
    cfWorkersTier: "free",
    d1ReadDailyLimit: 5_000_000,
    d1WriteDailyLimit: 100_000,
    workersRequestDailyLimit: 100_000,
    cronQuotaUtilizationPct: 80,
    sidecarHeartbeatSec: 60,
    ...overrides,
  } as AppConfig;
}

function mockStore(overrides: Partial<Store> = {}): Store {
  return {
    isCronIndexerPaused: vi.fn(async () => false),
    getQuotaSnapshot: vi.fn(async () => ({
      quotaDayUtc: "2026-09-02",
      rowsReadTotal: 0,
      rowsWrittenTotal: 0,
      workersRequestsTotal: 0,
      rowsReadCron: 0,
      rowsWrittenCron: 0,
      workersRequestsCron: 0,
    })),
    tryAcquireTickLease: vi.fn(async () => false),
    resetRunningJobs: vi.fn(async () => ({ reclaimed: 0 })),
    clearTickLease: vi.fn(async () => {}),
    flushQuotaUsage: vi.fn(async () => {}),
    ...overrides,
  } as unknown as Store;
}

describe("flushCronQuota", () => {
  it("flushes meter delta with requests defaulting to 1", async () => {
    const meter = new D1RowMeter("2026-09-02");
    meter.record(12, 3);
    const flushQuotaUsage = vi.fn(async () => {});
    const store = mockStore({ flushQuotaUsage });

    await flushCronQuota(store, meter, { rowsRead: 0, rowsWritten: 0 });

    expect(flushQuotaUsage).toHaveBeenCalledWith("cron", {
      reads: 12,
      writes: 3,
      requests: 1,
    });
  });
});

describe("runCronScheduled", () => {
  it("always flushes requests=1 when cron indexer is paused", async () => {
    const meter = new D1RowMeter("2026-09-02");
    const flushQuotaUsage = vi.fn(async () => {});
    const store = mockStore({
      isCronIndexerPaused: vi.fn(async () => true),
      flushQuotaUsage,
    });

    await runCronScheduled(store, {} as ChainRouter, cronConfig(), meter);

    expect(flushQuotaUsage).toHaveBeenCalledWith("cron", expect.objectContaining({ requests: 1 }));
    expect(store.getQuotaSnapshot).not.toHaveBeenCalled();
  });

  it("flushes requests=1 when quota pacing skips the tick", async () => {
    const meter = new D1RowMeter("2026-09-02");
    const flushQuotaUsage = vi.fn(async () => {});
    const store = mockStore({
      getQuotaSnapshot: vi.fn(async () => ({
        quotaDayUtc: "2026-09-02",
        rowsReadTotal: 5_000_001,
        rowsWrittenTotal: 0,
        workersRequestsTotal: 0,
        rowsReadCron: 0,
        rowsWrittenCron: 0,
        workersRequestsCron: 0,
      })),
      flushQuotaUsage,
    });

    await runCronScheduled(store, {} as ChainRouter, cronConfig(), meter);

    expect(store.getQuotaSnapshot).toHaveBeenCalled();
    expect(store.tryAcquireTickLease).not.toHaveBeenCalled();
    expect(flushQuotaUsage).toHaveBeenCalledWith("cron", expect.objectContaining({ requests: 1 }));
  });

  it("clears tick lease before flushing quota", async () => {
    const meter = new D1RowMeter("2026-09-02");
    const calls: string[] = [];
    const clearTickLease = vi.fn(async () => {
      calls.push("clear");
    });
    const flushQuotaUsage = vi.fn(async () => {
      calls.push("flush");
    });
    const store = mockStore({
      tryAcquireTickLease: vi.fn(async () => true),
      resetRunningJobs: vi.fn(async () => {
        calls.push("reset");
        return { reclaimed: 0 };
      }),
      clearTickLease,
      flushQuotaUsage,
    });

    await runCronScheduled(store, {} as ChainRouter, cronConfig(), meter);

    expect(calls.indexOf("clear")).toBeLessThan(calls.indexOf("flush"));
    expect(flushQuotaUsage).toHaveBeenCalledWith("cron", expect.objectContaining({ requests: 1 }));
  });
});
