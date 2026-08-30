import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@cointrace/core";

const openRemoteProductionStoreMock = vi.fn();

vi.mock("./remotePlatform.js", () => ({
  openRemoteProductionStore: (...args: unknown[]) => openRemoteProductionStoreMock(...args),
}));

const { runRemoteSidecar } = await import("./runRemote.js");

function minimalConfig(): AppConfig {
  return {
    databaseUrl: "file:./data/cointrace.db",
    esploraBase: "https://blockstream.info/api",
    mempoolBase: "https://mempool.space/api",
    chainPrimaryProvider: "esplora",
    rateLimitMs: 8000,
    jobsPerTick: 1,
    tickBudgetMs: 50000,
    runningJobStaleMs: 120000,
    cronIntervalSec: 60,
    crawlEnqueuePerCron: 1,
    pollHackerEnqueuePerCron: 1,
    hackerMaintenanceEveryNCrons: 10,
    downstreamPollIntervalSec: 600,
    downstreamPollEnqueuePerCron: 1,
    maxCrawlDepth: 5,
    maxGraphDepth: 2,
    minEdgeSats: 1000,
    balanceRefreshIntervalSec: 300,
    btcUsdPriceRefreshIntervalSec: 900,
    coldcardwatchSyncIntervalSec: 3600,
    coldcardwatchBase: "https://coldcardwatch.com",
    vercelTrackersSyncIntervalSec: 3600,
    coldcardSweepWatchBase: "https://coldcard-watch.vercel.app",
    coldcardHackTrackerBase: "https://coldcard-hack-tracker.vercel.app",
    environment: "development",
    corsOrigins: [],
    corsOriginsFromEnv: false,
    seedFilePath: "",
    seedDataJson: null,
    localWatchlistPath: "",
    localWatchlistDataJson: null,
    apiThresholdCooldownSec: 300,
    apiThresholdBaseSec: 300,
    apiThresholdMaxSec: 3600,
    maxChainCallsPerJob: 3,
    backfillTxsPerJob: 1,
    graphRateWindowSec: 60,
    graphContinuationRateLimit: 120,
    graphPageSizeDefault: 500,
    graphPageSizeMax: 1000,
    maxGraphVictims: 10000,
    maxGraphDownstream: 10000,
    recentHackersLimit: 5,
    hackersPollMs: 3600000,
    hackersPollMsSidecar: 60000,
    maxQueueDepth: 360,
    queueDrainFirstDepth: 1,
    jobsPerTickMax: 3,
    queueDepthPerExtraJob: 40,
    queueSoftThrottleDepth: 80,
    indexerJobDetails: true,
    indexerLogColor: true,
    indexerLogColorMode: "sidecar",
    sidecarHeartbeatSec: 30,
    jobDeferAfterAttempts: 20,
    jobDeferSec: 86400,
    subrequestLimitPerInvocation: 0,
    scheduleSubrequestReserve: 38,
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
    jobCpuGuardMs: 0,
  } as AppConfig;
}

describe("runRemoteSidecar guard", () => {
  beforeEach(() => {
    openRemoteProductionStoreMock.mockReset();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
  });

  it("refuses to start when cron is not paused", async () => {
    const dispose = vi.fn(async () => {});
    const store = {
      isCronIndexerPaused: vi.fn(async () => false),
      resetRunningJobs: vi.fn(),
      tryAcquireTickLease: vi.fn(),
      clearTickLease: vi.fn(),
    };
    openRemoteProductionStoreMock.mockResolvedValue({
      store,
      dispose,
    });

    await expect(runRemoteSidecar(minimalConfig(), ["run", "--remote"])).rejects.toThrow("exit:1");
    expect(dispose).toHaveBeenCalledOnce();
    expect(store.tryAcquireTickLease).not.toHaveBeenCalled();
  });
});
