import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";

const processJobsMock = vi.hoisted(() => vi.fn());
const scheduleBtcMock = vi.hoisted(() => vi.fn());
const scheduleCrawlMock = vi.hoisted(() => vi.fn());

vi.mock("./processor.js", () => ({
  processJobs: processJobsMock,
}));

vi.mock("./crawl.js", () => ({
  scheduleBtcUsdPriceRefresh: scheduleBtcMock,
  scheduleDownstreamCrawl: scheduleCrawlMock,
}));

import { runIndexerTick } from "./tick.js";

function tickStoreMock(overrides: Record<string, unknown> = {}): Store {
  return {
    setSubrequestBudget: vi.fn(),
    getSchedulerState: vi.fn().mockResolvedValue({ maintenanceCronCounter: 0 }),
    getQueueDepth: vi.fn().mockResolvedValue(0),
    hasPendingIngestContinuation: vi.fn().mockResolvedValue(false),
    listPendingIngestCandidates: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Store;
}

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
    subrequestLimitPerInvocation: 50,
    scheduleSubrequestReserve: 15,
    scheduleReserveMaintExtra: 10,
    maxSubrequestsPerJob: 0,
    maxEdgesPerJob: 0,
    maxGraphEdgesPerTx: 0,
    sweepRelayMinReceiveRatio: 0.7,
    sweepRelayMinVoutCount: 20,
    sweepRelayMinSpendTargetShare: 0.8,
    spendFanoutMinVoutCount: 20,
    spendFanoutMinOutputAddresses: 10,
    spendFanoutTopK: 5,
    graphBundleMinEdges: 2,
    jobReclaimDeferAfter: 3,
    jobReclaimDeferSec: 86400,
    backfillSkipReceivesPerJob: 25,
    maxVoutCountSkipGetTx: 20,
    d1BatchSize: 8,
    syncAddressesPerJob: 5,
  };
}

describe("runIndexerTick ordering", () => {
  beforeEach(() => {
    processJobsMock.mockReset();
    scheduleBtcMock.mockReset();
    scheduleCrawlMock.mockReset();
    processJobsMock.mockResolvedValue({ processed: 1, stopReason: "jobs_cap" });
    scheduleBtcMock.mockResolvedValue("skip");
    scheduleCrawlMock.mockResolvedValue({
      skipNonCritical: false,
      crawlEnqueued: 0,
      pollEnqueued: 0,
      maintTick: false,
    });
  });

  it("runs jobs before schedule when continuation is pending", async () => {
    const order: string[] = [];
    processJobsMock.mockImplementation(async () => {
      order.push("jobs");
      return { processed: 1, stopReason: "jobs_cap" };
    });
    scheduleBtcMock.mockImplementation(async () => {
      order.push("schedule-btc");
      return "skip";
    });
    scheduleCrawlMock.mockImplementation(async () => {
      order.push("schedule-crawl");
      return {
        skipNonCritical: false,
        crawlEnqueued: 0,
        pollEnqueued: 0,
        maintTick: false,
      };
    });

    const store = tickStoreMock({
      hasPendingIngestContinuation: vi.fn().mockResolvedValue(true),
    });
    const router = {} as ChainRouter;

    await runIndexerTick(store, router, baseConfig(), { schedule: true });

    expect(order[0]).toBe("jobs");
    expect(order).toContain("schedule-btc");
    expect(order.indexOf("jobs")).toBeLessThan(order.indexOf("schedule-btc"));
  });

  it("runs schedule before jobs when queue is empty and no continuation", async () => {
    const order: string[] = [];
    processJobsMock.mockImplementation(async () => {
      order.push("jobs");
      return { processed: 0, stopReason: "idle" };
    });
    scheduleBtcMock.mockImplementation(async () => {
      order.push("schedule-btc");
      return "skip";
    });
    scheduleCrawlMock.mockImplementation(async () => {
      order.push("schedule-crawl");
      return {
        skipNonCritical: false,
        crawlEnqueued: 0,
        pollEnqueued: 0,
        maintTick: false,
      };
    });

    const store = tickStoreMock();
    const router = {} as ChainRouter;

    await runIndexerTick(store, router, baseConfig(), { schedule: true });

    expect(order[0]).toBe("schedule-btc");
    expect(order.indexOf("schedule-btc")).toBeLessThan(order.indexOf("jobs"));
  });

  it("runs jobs before schedule when queue depth meets drain threshold", async () => {
    const order: string[] = [];
    processJobsMock.mockImplementation(async () => {
      order.push("jobs");
      return { processed: 1, stopReason: "jobs_cap" };
    });
    scheduleBtcMock.mockImplementation(async () => {
      order.push("schedule-btc");
      return "skip";
    });
    scheduleCrawlMock.mockImplementation(async () => {
      order.push("schedule-crawl");
      return {
        skipNonCritical: false,
        crawlEnqueued: 0,
        pollEnqueued: 0,
        maintTick: false,
        throttled: false,
      };
    });

    const store = tickStoreMock({ getQueueDepth: vi.fn().mockResolvedValue(12) });
    const router = {} as ChainRouter;

    await runIndexerTick(store, router, baseConfig(), { schedule: true });

    expect(order[0]).toBe("jobs");
    expect(order.indexOf("jobs")).toBeLessThan(order.indexOf("schedule-btc"));
  });

  it("passes effective jobsPerTick burst cap to processJobs", async () => {
    const store = tickStoreMock({ getQueueDepth: vi.fn().mockResolvedValue(45) });
    const router = {} as ChainRouter;

    await runIndexerTick(store, router, baseConfig(), { schedule: true });

    expect(processJobsMock).toHaveBeenCalledWith(
      store,
      router,
      expect.anything(),
      expect.objectContaining({ jobsPerTick: 2 }),
    );
  });
});
