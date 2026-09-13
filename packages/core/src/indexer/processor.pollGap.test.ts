import { beforeEach, describe, expect, it, vi } from "vitest";
import { processJob } from "./processor.js";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Job, Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";

const { processTxForHackTraceMock } = vi.hoisted(() => ({
  processTxForHackTraceMock: vi.fn().mockResolvedValue({ traceComplete: true, captureChainCalls: 0 }),
}));

vi.mock("../graph/builder.js", () => ({
  getHackerAddressSet: vi.fn().mockResolvedValue(new Set(["bc1qhacker"])),
  processTxForHackTrace: processTxForHackTraceMock,
}));

const ADDRESS = "bc1qdown";

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
    maxVoutCountSkipGetTx: 20,
    traceFlaggedHackerReceives: true,
    spendFanoutMinVoutCount: 20,
    spendFanoutMinOutputAddresses: 10,
    spendFanoutTopK: 5,
    ...overrides,
  };
}

function makeJob(type: string, payload: Record<string, unknown>): Job {
  return {
    id: 1,
    type,
    payloadJson: JSON.stringify(payload),
    status: "running",
    priority: JOB_PRIORITY.POLL_DOWNSTREAM,
    runAfter: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
  } as Job;
}

describe("poll_downstream_address gap fill", () => {
  beforeEach(() => {
    processTxForHackTraceMock.mockClear();
  });

  it("does not advance lastSeen when the cursor is missing from page 1", async () => {
    const getAddressTxs = vi.fn().mockResolvedValue([
      {
        txid: "tip",
        vin: [{ prevout: { scriptpubkey_address: "bc1qother", value: 1000 } }],
        vout: [{ scriptpubkey_address: ADDRESS, value: 1000 }],
      },
    ]);
    const upsertSyncState = vi.fn();
    const store = {
      getDownstreamExpandContext: vi.fn().mockResolvedValue(
        new Map([[ADDRESS, { expandStatus: "expanded", inboundSats: 1_000_000 }]]),
      ),
      getAddress: vi.fn().mockResolvedValue({ hopFromHacker: 1, expandProfile: null }),
      getSyncState: vi.fn().mockResolvedValue({ lastSeenTxid: "old-cursor" }),
      sumOutFromHacker: vi.fn().mockResolvedValue(1000),
      enqueueJob: vi.fn(),
      upsertSyncState,
      touchSyncPoll: vi.fn(),
      flushRecentHackerActivity: vi.fn(),
    } as unknown as Store;
    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressTxs: typeof getAddressTxs }) => unknown) =>
        fn({ getAddressTxs }),
      ),
    } as unknown as ChainRouter;

    await processJob(store, router, baseConfig({ maxChainCallsPerJob: 1 }), makeJob("poll_downstream_address", { address: ADDRESS }));

    expect(upsertSyncState).not.toHaveBeenCalled();
    expect(store.enqueueJob).toHaveBeenCalledWith(
      "poll_downstream_address",
      expect.objectContaining({ cursorMiss: true, newestTxid: "tip" }),
      JOB_PRIORITY.POLL_DOWNSTREAM,
    );
  });

  it("jumps lastSeen when the spend gap is below the floor", async () => {
    const getAddressTxs = vi.fn().mockResolvedValue([
      {
        txid: "tip",
        vin: [{ prevout: { scriptpubkey_address: "bc1qother", value: 1000 } }],
        vout: [{ scriptpubkey_address: ADDRESS, value: 1000 }],
      },
    ]);
    const getAddressStats = vi.fn().mockResolvedValue({
      chain_stats: { spent_txo_sum: 50_000, funded_txo_sum: 0, tx_count: 10 },
      mempool_stats: { spent_txo_sum: 0, funded_txo_sum: 0 },
    });
    const upsertSyncState = vi.fn();
    const store = {
      getDownstreamExpandContext: vi.fn().mockResolvedValue(
        new Map([[ADDRESS, { expandStatus: "expanded", inboundSats: 1_000_000 }]]),
      ),
      getAddress: vi.fn().mockResolvedValue({ hopFromHacker: 1, expandProfile: null }),
      getSyncState: vi.fn().mockResolvedValue({ lastSeenTxid: "old-cursor" }),
      sumOutFromHacker: vi.fn().mockResolvedValue(1000),
      enqueueJob: vi.fn(),
      upsertSyncState,
      touchSyncPoll: vi.fn(),
      flushRecentHackerActivity: vi.fn(),
    } as unknown as Store;
    const router = {
      withProvider: vi.fn(async (fn: (p: {
        getAddressTxs: typeof getAddressTxs;
        getAddressStats: typeof getAddressStats;
      }) => unknown) => fn({ getAddressTxs, getAddressStats })),
    } as unknown as ChainRouter;

    await processJob(store, router, baseConfig(), makeJob("poll_downstream_address", { address: ADDRESS }));

    expect(getAddressStats).toHaveBeenCalled();
    expect(upsertSyncState).toHaveBeenCalledWith(ADDRESS, {
      lastSeenTxid: "tip",
      lastBlockHeight: null,
    });
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("paginates until lastSeen and processes a buried spend", async () => {
    const getAddressTxs = vi.fn().mockResolvedValue([
      {
        txid: "tip",
        vin: [{ prevout: { scriptpubkey_address: "bc1qother", value: 1000 } }],
        vout: [{ scriptpubkey_address: ADDRESS, value: 1000 }],
      },
    ]);
    const getAddressStats = vi.fn().mockResolvedValue({
      chain_stats: { spent_txo_sum: 3_400_000_000_000, funded_txo_sum: 0, tx_count: 10 },
      mempool_stats: { spent_txo_sum: 0, funded_txo_sum: 0 },
    });
    const fetchAddressTxPage = vi.fn().mockResolvedValue({
      txs: [
        {
          txid: "refund",
          vin: [{ prevout: { scriptpubkey_address: ADDRESS, value: 150_000 } }],
          vout: [{ scriptpubkey_address: "bc1qvictim", value: 150_000 }],
        },
        { txid: "old-cursor" },
      ],
    });
    const upsertSyncState = vi.fn();
    const store = {
      getDownstreamExpandContext: vi.fn().mockResolvedValue(
        new Map([[ADDRESS, { expandStatus: "expanded", inboundSats: 1_000_000 }]]),
      ),
      getAddress: vi.fn().mockResolvedValue({ hopFromHacker: 1, expandProfile: null }),
      getSyncState: vi.fn().mockResolvedValue({ lastSeenTxid: "old-cursor" }),
      sumOutFromHacker: vi.fn().mockResolvedValue(1000),
      enqueueJob: vi.fn(),
      upsertSyncState,
      touchSyncPoll: vi.fn(),
      getTransaction: vi.fn().mockResolvedValue(null),
      flushRecentHackerActivity: vi.fn(),
    } as unknown as Store;
    const router = {
      fetchAddressTxPage,
      withProvider: vi.fn(async (fn: (p: {
        getAddressTxs: typeof getAddressTxs;
        getAddressStats: typeof getAddressStats;
      }) => unknown) => fn({ getAddressTxs, getAddressStats })),
    } as unknown as ChainRouter;

    await processJob(store, router, baseConfig(), makeJob("poll_downstream_address", { address: ADDRESS }));

    expect(fetchAddressTxPage).toHaveBeenCalled();
    expect(processTxForHackTraceMock).toHaveBeenCalled();
    expect(upsertSyncState).toHaveBeenCalledWith(ADDRESS, {
      lastSeenTxid: "tip",
      lastBlockHeight: null,
    });
  });
});

describe("poll_hacker_address lastSeen miss", () => {
  it("does not treat a missing cursor as 25 new txs", async () => {
    const getAddressTxs = vi.fn().mockResolvedValue([{ txid: "tip" }, { txid: "spam" }]);
    const upsertSyncState = vi.fn();
    const touchSyncPoll = vi.fn();
    const store = {
      getSyncState: vi.fn().mockResolvedValue({ lastSeenTxid: "buried" }),
      enqueueJob: vi.fn(),
      upsertSyncState,
      touchSyncPoll,
      flushRecentHackerActivity: vi.fn(),
    } as unknown as Store;
    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressTxs: typeof getAddressTxs }) => unknown) =>
        fn({ getAddressTxs }),
      ),
    } as unknown as ChainRouter;

    await processJob(
      store,
      router,
      baseConfig(),
      makeJob("poll_hacker_address", { address: "bc1qhacker" }),
    );

    expect(upsertSyncState).not.toHaveBeenCalled();
    expect(store.enqueueJob).not.toHaveBeenCalled();
    expect(touchSyncPoll).toHaveBeenCalledWith("bc1qhacker");
  });
});
