import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import {
  hasResumableBackfillState,
  runReBackfillHackers,
  runReBackfillHackersWait,
  runReBackfillHackerWait,
} from "./processor.js";

vi.mock("../graph/builder.js", () => ({
  getHackerAddressSet: vi.fn().mockResolvedValue(new Set(["bc1qcollector"])),
  processTxForHackTrace: vi.fn().mockResolvedValue(undefined),
}));

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
  };
}

function emptyPageRouter(): ChainRouter {
  return {
    fetchAddressTxPage: vi.fn().mockResolvedValue({ txs: [] }),
  } as unknown as ChainRouter;
}

describe("hasResumableBackfillState", () => {
  it("returns true when chainCursor is saved regardless of expand_status", () => {
    expect(
      hasResumableBackfillState({
        payload: { chainCursor: "abc123" },
        backfillComplete: false,
      }),
    ).toBe(true);
  });

  it("returns false when backfill is complete", () => {
    expect(
      hasResumableBackfillState({
        payload: { chainCursor: "abc123" },
        backfillComplete: true,
      }),
    ).toBe(false);
  });

  it("returns false when payload is empty", () => {
    expect(hasResumableBackfillState({ payload: {}, backfillComplete: false })).toBe(false);
  });
});

describe("runReBackfillHackerWait", () => {
  const address = "bc1qcollector";

  it("resumes without resetting saved payload when not --fresh", async () => {
    const upsertBackfillState = vi.fn();
    const setExpandStatus = vi.fn();
    let backfillComplete = false;
    const store = {
      getBackfillState: vi.fn().mockImplementation(async () => ({
        payload: { chainCursor: "saved-cursor" },
        backfillComplete,
      })),
      getAddress: vi.fn().mockResolvedValue({ expandStatus: "expanded" }),
      setExpandStatus,
      upsertBackfillState: vi.fn().mockImplementation(async (_addr, payload, complete) => {
        upsertBackfillState(_addr, payload, complete);
        if (complete === true) backfillComplete = true;
      }),
      upsertSyncState: vi.fn(),
      getTransaction: vi.fn().mockResolvedValue({ txid: "existing" }),
      enqueueJob: vi.fn(),
      recalcTotalReceived: vi.fn(),
      countIndexedTxsForHacker: vi.fn().mockResolvedValue(10),
    } as unknown as Store;

    await runReBackfillHackerWait(store, emptyPageRouter(), baseConfig(), address);

    expect(upsertBackfillState).not.toHaveBeenCalledWith(address, null, false);
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("resets state when --fresh", async () => {
    const store = {
      getBackfillState: vi.fn().mockImplementation(async () => ({
        payload: { chainCursor: "saved-cursor" },
        backfillComplete: false,
      })),
      getAddress: vi.fn().mockResolvedValue({ expandStatus: "backfilling" }),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn().mockImplementation(async (_addr, _payload, complete) => {
        if (complete === true) {
          (store.getBackfillState as ReturnType<typeof vi.fn>).mockResolvedValue({
            payload: null,
            backfillComplete: true,
          });
        }
      }),
      upsertSyncState: vi.fn(),
      getTransaction: vi.fn(),
      enqueueJob: vi.fn(),
      recalcTotalReceived: vi.fn(),
      countIndexedTxsForHacker: vi.fn().mockResolvedValue(10),
    } as unknown as Store;

    await runReBackfillHackerWait(store, emptyPageRouter(), baseConfig(), address, { fresh: true });

    expect(store.upsertBackfillState).toHaveBeenCalledWith(address, null, false);
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("does not enqueue continuation jobs during --wait", async () => {
    const store = {
      getBackfillState: vi.fn().mockResolvedValue({ payload: null, backfillComplete: false }),
      getAddress: vi.fn().mockResolvedValue({ expandStatus: "pending" }),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn(),
      upsertSyncState: vi.fn(),
      getTransaction: vi.fn(),
      enqueueJob: vi.fn(),
      recalcTotalReceived: vi.fn(),
      countIndexedTxsForHacker: vi.fn().mockResolvedValue(0),
    } as unknown as Store;

    const router = {
      fetchAddressTxPage: vi
        .fn()
        .mockResolvedValueOnce({
          txs: [{ txid: "tx1", status: { block_height: 1 } }],
        })
        .mockResolvedValue({ txs: [] }),
    } as unknown as ChainRouter;

    (store.getBackfillState as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ payload: null, backfillComplete: false })
      .mockResolvedValueOnce({
        payload: { chainCursor: "tx1", pendingTxids: [], pagesExhausted: true },
        backfillComplete: false,
      })
      .mockResolvedValue({ payload: null, backfillComplete: true });

    await runReBackfillHackerWait(store, router, baseConfig(), address);

    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("sets expanded and breaks when backfillComplete but expand_status is backfilling", async () => {
    const setExpandStatus = vi.fn();
    const store = {
      getBackfillState: vi.fn().mockResolvedValue({ payload: null, backfillComplete: true }),
      getAddress: vi.fn().mockResolvedValue({ expandStatus: "backfilling" }),
      setExpandStatus,
      upsertBackfillState: vi.fn(),
      upsertSyncState: vi.fn(),
      getTransaction: vi.fn(),
      enqueueJob: vi.fn(),
      recalcTotalReceived: vi.fn(),
      countIndexedTxsForHacker: vi.fn().mockResolvedValue(100),
    } as unknown as Store;

    await runReBackfillHackerWait(store, emptyPageRouter(), baseConfig(), address, { fresh: true });

    expect(setExpandStatus).toHaveBeenCalledWith(address, "expanded");
  });
});

describe("runReBackfillHackers", () => {
  const completeAddr = "bc1qcomplete";
  const resumableAddr = "bc1qresumable";
  const pendingAddr = "bc1qpending";

  it("skips backfill_complete hackers when not --fresh", async () => {
    const store = {
      listHackers: vi.fn().mockResolvedValue([
        { address: completeAddr },
        { address: pendingAddr },
      ]),
      getBackfillState: vi.fn().mockImplementation(async (addr) => {
        if (addr === completeAddr) return { payload: {}, backfillComplete: true };
        return { payload: null, backfillComplete: false };
      }),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn(),
      enqueueJob: vi.fn(),
    } as unknown as Store;

    const n = await runReBackfillHackers(store);

    expect(n).toBe(1);
    expect(store.enqueueJob).toHaveBeenCalledTimes(1);
    expect(store.enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      { address: pendingAddr },
      JOB_PRIORITY.BACKFILL_HACKER,
      expect.any(String),
    );
  });

  it("resumes without reset when chainCursor is saved", async () => {
    const store = {
      listHackers: vi.fn().mockResolvedValue([{ address: resumableAddr }]),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: { chainCursor: "cursor-abc" },
        backfillComplete: false,
      }),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn(),
      enqueueJob: vi.fn(),
    } as unknown as Store;

    const n = await runReBackfillHackers(store);

    expect(n).toBe(1);
    expect(store.upsertBackfillState).not.toHaveBeenCalled();
    expect(store.setExpandStatus).toHaveBeenCalledWith(resumableAddr, "backfilling");
    expect(store.enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      { address: resumableAddr, chainCursor: "cursor-abc" },
      JOB_PRIORITY.BACKFILL_HACKER,
      expect.any(String),
    );
  });

  it("resets all hackers when --fresh", async () => {
    const store = {
      listHackers: vi.fn().mockResolvedValue([
        { address: completeAddr },
        { address: resumableAddr },
      ]),
      getBackfillState: vi.fn().mockResolvedValue({
        payload: { chainCursor: "cursor-abc" },
        backfillComplete: true,
      }),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn(),
      enqueueJob: vi.fn(),
    } as unknown as Store;

    const n = await runReBackfillHackers(store, { fresh: true });

    expect(n).toBe(2);
    expect(store.upsertBackfillState).toHaveBeenCalledTimes(2);
    expect(store.upsertBackfillState).toHaveBeenCalledWith(completeAddr, null, false);
    expect(store.upsertBackfillState).toHaveBeenCalledWith(resumableAddr, null, false);
    expect(store.setExpandStatus).toHaveBeenCalledWith(completeAddr, "pending");
    expect(store.setExpandStatus).toHaveBeenCalledWith(resumableAddr, "pending");
  });
});

describe("runReBackfillHackersWait", () => {
  const completeAddr = "bc1qcomplete";
  const incompleteAddr = "bc1qincomplete";

  it("skips complete hackers and waits on incomplete ones", async () => {
    let backfillComplete = false;
    const store = {
      listHackers: vi.fn().mockResolvedValue([
        { address: completeAddr },
        { address: incompleteAddr },
      ]),
      getBackfillState: vi.fn().mockImplementation(async (addr) => {
        if (addr === completeAddr) return { payload: {}, backfillComplete: true };
        return { payload: null, backfillComplete };
      }),
      getAddress: vi.fn().mockResolvedValue({ expandStatus: "pending" }),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn().mockImplementation(async (_addr, _payload, complete) => {
        if (complete === true) backfillComplete = true;
      }),
      upsertSyncState: vi.fn(),
      getTransaction: vi.fn(),
      enqueueJob: vi.fn(),
      recalcTotalReceived: vi.fn(),
      countIndexedTxsForHacker: vi.fn().mockResolvedValue(0),
    } as unknown as Store;

    const n = await runReBackfillHackersWait(store, emptyPageRouter(), baseConfig());

    expect(n).toBe(1);
    expect(store.enqueueJob).not.toHaveBeenCalled();
    expect(store.setExpandStatus).toHaveBeenCalledWith(incompleteAddr, expect.any(String));
    expect(store.setExpandStatus).not.toHaveBeenCalledWith(completeAddr, expect.any(String));
  });
});
