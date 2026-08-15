import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Job, Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { processJob } from "./processor.js";

const { processTxForHackTraceMock } = vi.hoisted(() => ({
  processTxForHackTraceMock: vi.fn().mockResolvedValue({ traceComplete: true }),
}));

vi.mock("../graph/builder.js", () => ({
  getHackerAddressSet: vi.fn().mockResolvedValue(new Set(["bc1qhacker"])),
  processTxForHackTrace: processTxForHackTraceMock,
}));

const ADDRESS = "bc1qhacker";

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
    ...overrides,
  };
}

function makeJob(type: Job["type"], payload: Record<string, unknown>): Job {
  return {
    id: 1,
    type,
    payloadJson: JSON.stringify(payload),
    status: "running",
    priority: JOB_PRIORITY.BACKFILL_HACKER,
    attempts: 0,
    runAfter: new Date().toISOString(),
    lastError: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

describe("single chain call per job", () => {
  beforeEach(() => {
    processTxForHackTraceMock.mockClear();
  });

  it("backfill fetch only when budget=1 and no pending txs", async () => {
    const fetchAddressTxPage = vi.fn().mockResolvedValue({
      txs: [
        { txid: "tx1", status: { block_height: 1 } },
        { txid: "tx2", status: { block_height: 1 } },
      ],
    });
    const upsertBackfillState = vi.fn();
    const enqueueJob = vi.fn();
    const store = {
      getBackfillState: vi.fn().mockResolvedValue(null),
      setExpandStatus: vi.fn(),
      getAddress: vi.fn().mockResolvedValue(null),
      upsertBackfillState,
      enqueueJob,
      getTransaction: vi.fn().mockResolvedValue(null),
    } as unknown as Store;
    const withProvider = vi.fn(async (fn: (p: { getTx: () => Promise<{ vin: unknown[]; vout: unknown[] }> }) => unknown) =>
      fn({
        getTx: async () => ({
          vin: [{ prevout: { scriptpubkey_address: ADDRESS } }],
          vout: [{ scriptpubkey_address: "bc1qdest", value: 1000 }],
        }),
      }),
    );
    const router = { fetchAddressTxPage, withProvider } as unknown as ChainRouter;

    await processJob(
      store,
      router,
      baseConfig(),
      makeJob("backfill_hacker_address", { address: ADDRESS }),
    );

    expect(fetchAddressTxPage).toHaveBeenCalledTimes(1);
    expect(processTxForHackTraceMock).not.toHaveBeenCalled();
    expect(upsertBackfillState).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({
        pendingTxids: ["tx2", "tx1"],
        processedIndex: 0,
      }),
      false,
    );
    expect(enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      expect.objectContaining({ pendingTxids: ["tx2", "tx1"] }),
      JOB_PRIORITY.BACKFILL_HACKER,
    );
  });

  it("backfill processes one tx when budget=1 and pending txs exist", async () => {
    const fetchAddressTxPage = vi.fn();
    const upsertBackfillState = vi.fn();
    const enqueueJob = vi.fn();
    const store = {
      getBackfillState: vi.fn().mockResolvedValue(null),
      setExpandStatus: vi.fn(),
      getAddress: vi.fn().mockResolvedValue(null),
      upsertBackfillState,
      enqueueJob,
      getTransaction: vi.fn().mockResolvedValue(null),
    } as unknown as Store;
    const withProvider = vi.fn(async (fn: (p: { getTx: () => Promise<{ vin: unknown[]; vout: unknown[] }> }) => unknown) =>
      fn({
        getTx: async () => ({
          vin: [{ prevout: { scriptpubkey_address: ADDRESS } }],
          vout: [{ scriptpubkey_address: "bc1qdest", value: 1000 }],
        }),
      }),
    );
    const router = { fetchAddressTxPage, withProvider } as unknown as ChainRouter;

    await processJob(
      store,
      router,
      baseConfig(),
      makeJob("backfill_hacker_address", {
        address: ADDRESS,
        pendingTxids: ["tx1", "tx2"],
        processedIndex: 0,
        pagesExhausted: true,
      }),
    );

    expect(fetchAddressTxPage).not.toHaveBeenCalled();
    expect(processTxForHackTraceMock).toHaveBeenCalledTimes(1);
    expect(processTxForHackTraceMock).toHaveBeenCalledWith(
      store,
      router,
      "tx1",
      expect.any(Set),
      expect.objectContaining({ spendingAddress: ADDRESS }),
    );
    expect(upsertBackfillState).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({ processedIndex: 1, pendingTxids: ["tx1", "tx2"] }),
      false,
    );
  });

  it("backfill bulk-skips classified receives without trace calls", async () => {
    const fetchAddressTxPage = vi.fn();
    const upsertBackfillState = vi.fn();
    const enqueueJob = vi.fn();
    const pendingTxs = ["tx0", "tx1", "tx2", "tx3", "tx4"].map((txid) => ({
      txid,
      isSpend: false,
      voutCount: 1,
      outputAddressCount: 1,
    }));
    const store = {
      getBackfillState: vi.fn().mockResolvedValue(null),
      setExpandStatus: vi.fn(),
      getAddress: vi.fn().mockResolvedValue(null),
      upsertBackfillState,
      enqueueJob,
      getTransaction: vi.fn(),
    } as unknown as Store;
    const router = { fetchAddressTxPage } as unknown as ChainRouter;

    await processJob(
      store,
      router,
      baseConfig({ backfillTxsPerJob: 1, maxChainCallsPerJob: 0 }),
      makeJob("backfill_hacker_address", {
        address: ADDRESS,
        pendingTxs,
        pendingTxids: pendingTxs.map((p) => p.txid),
        processedIndex: 0,
        pagesExhausted: false,
      }),
    );

    expect(fetchAddressTxPage).not.toHaveBeenCalled();
    expect(processTxForHackTraceMock).not.toHaveBeenCalled();
    expect(store.getTransaction).not.toHaveBeenCalled();
    expect(upsertBackfillState).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({
        processedIndex: 0,
        pendingTxids: [],
        pendingTxs: [],
        pagesExhausted: false,
      }),
      false,
    );
    expect(enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      expect.objectContaining({ pendingTxids: [], pagesExhausted: false }),
      JOB_PRIORITY.BACKFILL_HACKER,
    );
  });

  it("backfill fetches and processes multiple txs when budget=0", async () => {
    const fetchAddressTxPage = vi.fn().mockResolvedValue({
      txs: [{ txid: "tx1", status: { block_height: 1 } }],
    });
    const store = {
      getBackfillState: vi.fn().mockResolvedValue(null),
      setExpandStatus: vi.fn(),
      getAddress: vi.fn().mockResolvedValue(null),
      upsertBackfillState: vi.fn(),
      enqueueJob: vi.fn(),
      getTransaction: vi.fn().mockResolvedValue(null),
    } as unknown as Store;
    const withProvider = vi.fn(async (fn: (p: { getTx: () => Promise<{ vin: unknown[]; vout: unknown[] }> }) => unknown) =>
      fn({
        getTx: async () => ({
          vin: [{ prevout: { scriptpubkey_address: ADDRESS } }],
          vout: [{ scriptpubkey_address: "bc1qdest", value: 1000 }],
        }),
      }),
    );
    const router = { fetchAddressTxPage, withProvider } as unknown as ChainRouter;

    await processJob(
      store,
      router,
      baseConfig({ maxChainCallsPerJob: 0, backfillTxsPerJob: 5 }),
      makeJob("backfill_hacker_address", { address: ADDRESS }),
    );

    expect(fetchAddressTxPage).toHaveBeenCalledTimes(1);
    expect(processTxForHackTraceMock).toHaveBeenCalledTimes(1);
  });

  it("expand_downstream fetches only when budget=1", async () => {
    const fetchAddressTxPage = vi.fn().mockResolvedValue({
      txs: [{ txid: "tx1", status: { block_height: 1 } }],
    });
    const enqueueJob = vi.fn();
    const store = {
      getAddress: vi.fn().mockResolvedValue({ hopFromHacker: 1 }),
      setExpandStatus: vi.fn(),
      enqueueJob,
      getTransaction: vi.fn().mockResolvedValue(null),
      getEdgesFromAddress: vi.fn().mockResolvedValue([]),
    } as unknown as Store;
    const withProvider = vi.fn(async (fn: (p: { getTx: () => Promise<{ vin: unknown[]; vout: unknown[] }> }) => unknown) =>
      fn({
        getTx: async () => ({
          vin: [{ prevout: { scriptpubkey_address: ADDRESS } }],
          vout: [{ scriptpubkey_address: "bc1qdest", value: 1000 }],
        }),
      }),
    );
    const router = { fetchAddressTxPage, withProvider } as unknown as ChainRouter;

    await processJob(
      store,
      router,
      baseConfig(),
      makeJob("expand_downstream", { address: ADDRESS }),
    );

    expect(fetchAddressTxPage).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith(
      "expand_downstream",
      expect.objectContaining({ pendingTxids: ["tx1"], processedIndex: 0 }),
      JOB_PRIORITY.CRON_EXPAND,
    );
  });

  it("poll_hacker fetch then process across two invocations", async () => {
    const getAddressTxs = vi
      .fn()
      .mockResolvedValue([{ txid: "tx-new", status: { block_height: 99 } }]);
    const getTx = vi.fn().mockResolvedValue({
      txid: "tx-new",
      vin: [{ prevout: { scriptpubkey_address: ADDRESS, value: 1000 } }],
      vout: [{ scriptpubkey_address: "bc1qdest", value: 500 }],
    });
    const withProvider = vi.fn(async (fn: (p: { getAddressTxs: typeof getAddressTxs; getTx: typeof getTx }) => unknown) =>
      fn({ getAddressTxs, getTx }),
    );
    const enqueueJob = vi.fn();
    const upsertSyncState = vi.fn();
    const touchSyncPoll = vi.fn();
    const store = {
      getSyncState: vi.fn().mockResolvedValue({ lastSeenTxid: "tx-old" }),
      getTransaction: vi.fn().mockResolvedValue(null),
      enqueueJob,
      upsertSyncState,
      touchSyncPoll,
    } as unknown as Store;
    const router = { withProvider } as unknown as ChainRouter;
    const config = baseConfig();

    await processJob(
      store,
      router,
      config,
      makeJob("poll_hacker_address", { address: ADDRESS }),
    );

    expect(withProvider).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith(
      "poll_hacker_address",
      expect.objectContaining({
        pollFetched: true,
        pendingTxids: ["tx-new"],
        processedIndex: 0,
      }),
      JOB_PRIORITY.POLL_HACKER,
    );
    expect(upsertSyncState).not.toHaveBeenCalled();

    processTxForHackTraceMock.mockClear();
    getTx.mockClear();
    getAddressTxs.mockClear();
    withProvider.mockClear();

    await processJob(
      store,
      router,
      config,
      makeJob("poll_hacker_address", {
        address: ADDRESS,
        pollFetched: true,
        pendingTxids: ["tx-new"],
        processedIndex: 0,
        newestTxid: "tx-new",
        newestBlockHeight: 99,
      }),
    );

    expect(withProvider).toHaveBeenCalledTimes(1);
    expect(processTxForHackTraceMock).toHaveBeenCalledTimes(1);
    expect(upsertSyncState).toHaveBeenCalledWith(ADDRESS, {
      lastSeenTxid: "tx-new",
      lastBlockHeight: 99,
    });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });
});
