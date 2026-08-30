import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@cointrace/core";

const openRemoteProductionStoreMock = vi.fn();
const reconnectRemoteProductionStoreMock = vi.fn();
const runIndexerTickMock = vi.fn();

vi.mock("./remotePlatform.js", () => ({
  openRemoteProductionStore: (...args: unknown[]) => openRemoteProductionStoreMock(...args),
  reconnectRemoteProductionStore: (...args: unknown[]) => reconnectRemoteProductionStoreMock(...args),
}));

vi.mock("@cointrace/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cointrace/core")>();
  return {
    ...actual,
    runIndexerTick: (...args: unknown[]) => runIndexerTickMock(...args),
  };
});

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

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    isCronIndexerPaused: vi.fn(async () => true),
    resetRunningJobs: vi.fn(async () => ({ reclaimed: 0 })),
    tryAcquireTickLease: vi.fn(),
    clearTickLease: vi.fn(async () => {}),
    getQueueDepth: vi.fn(async () => 0),
    getActiveJobSummary: vi.fn(async () => []),
    getSchedulerState: vi.fn(async () => ({})),
    ...overrides,
  };
}

function mockRemoteHandle(store: ReturnType<typeof makeStore>) {
  const dispose = vi.fn(async () => {});
  openRemoteProductionStoreMock.mockResolvedValue({ store, dispose });
  reconnectRemoteProductionStoreMock.mockImplementation(async () => {
    const handle = { store, dispose };
    return handle;
  });
  return { store, dispose };
}

function stopAfterNextAcquire(tryAcquireTickLease: ReturnType<typeof vi.fn>) {
  let acquireCalls = 0;
  tryAcquireTickLease.mockImplementation(async () => {
    acquireCalls++;
    if (acquireCalls >= 2) {
      process.emit("SIGTERM");
      await new Promise((r) => setImmediate(r));
    }
    return acquireCalls === 1;
  });
}

describe("runRemoteSidecar guard", () => {
  beforeEach(() => {
    openRemoteProductionStoreMock.mockReset();
    reconnectRemoteProductionStoreMock.mockReset();
    runIndexerTickMock.mockReset();
    runIndexerTickMock.mockResolvedValue({ jobsProcessed: 1 });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    vi.spyOn(global, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    vi.spyOn(global, "clearInterval").mockImplementation(() => {});
  });

  it("refuses to start when cron is not paused", async () => {
    const { store, dispose } = mockRemoteHandle(
      makeStore({ isCronIndexerPaused: vi.fn(async () => false) }),
    );

    await expect(runRemoteSidecar(minimalConfig(), ["run", "--remote"])).rejects.toThrow("exit:1");
    expect(dispose).toHaveBeenCalledOnce();
    expect(store.tryAcquireTickLease).not.toHaveBeenCalled();
  });
});

describe("runRemoteSidecar resilience", () => {
  beforeEach(() => {
    openRemoteProductionStoreMock.mockReset();
    reconnectRemoteProductionStoreMock.mockReset();
    runIndexerTickMock.mockReset();
    runIndexerTickMock.mockResolvedValue({ jobsProcessed: 1 });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    vi.spyOn(global, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
    vi.spyOn(global, "clearInterval").mockImplementation(() => {});
  });

  it("continues when clearTickLease rejects after a successful tick", async () => {
    const store = makeStore({
      clearTickLease: vi.fn(async () => {
        throw new Error("Failed query: update scheduler_state");
      }),
    });
    mockRemoteHandle(store);
    stopAfterNextAcquire(store.tryAcquireTickLease as ReturnType<typeof vi.fn>);

    const promise = runRemoteSidecar(minimalConfig(), ["run", "--remote"]);
    await vi.waitFor(() => expect(runIndexerTickMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(store.clearTickLease).toHaveBeenCalled());
    await promise;

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("reconnects on transport error during lease acquire and continues", async () => {
    const transportErr = new Error("Failed query: update scheduler_state", {
      cause: new Error("D1_ERROR: internal error; reference = v0dri"),
    });
    const store = makeStore();
    mockRemoteHandle(store);

    let acquireCalls = 0;
    store.tryAcquireTickLease.mockImplementation(async () => {
      acquireCalls++;
      if (acquireCalls === 1) throw transportErr;
      if (acquireCalls >= 3) {
        process.emit("SIGTERM");
        await new Promise((r) => setImmediate(r));
      }
      return acquireCalls === 2;
    });

    const promise = runRemoteSidecar(minimalConfig(), ["run", "--remote"]);
    await vi.waitFor(() => expect(reconnectRemoteProductionStoreMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(runIndexerTickMock).toHaveBeenCalled());
    await promise;

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("backs off and stays alive when reconnect fails", async () => {
    const transportErr = new Error("Failed query: select", {
      cause: new Error("D1_ERROR: internal error; reference = abc"),
    });
    const store = makeStore();
    mockRemoteHandle(store);
    reconnectRemoteProductionStoreMock.mockRejectedValue(new Error("reconnect failed"));

    let acquireCalls = 0;
    store.tryAcquireTickLease.mockImplementation(async () => {
      acquireCalls++;
      if (acquireCalls === 1) throw transportErr;
      if (acquireCalls === 2) {
        process.emit("SIGTERM");
        await new Promise((r) => setImmediate(r));
      }
      return false;
    });

    const promise = runRemoteSidecar(minimalConfig(), ["run", "--remote"]);
    await vi.waitFor(() => expect(reconnectRemoteProductionStoreMock).toHaveBeenCalled(), {
      timeout: 8_000,
    });
    await promise;

    expect(process.exit).not.toHaveBeenCalledWith(1);
  }, 12_000);
});
