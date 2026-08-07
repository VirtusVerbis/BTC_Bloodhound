import { describe, expect, it, vi } from "vitest";
import { processJob } from "./processor.js";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Job, Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";

function baseConfig(): AppConfig {
  return {
    databaseUrl: "file:./test.db",
    esploraBase: "https://blockstream.info/api",
    mempoolBase: "https://mempool.space/api",
    rateLimitMs: 3000,
    jobsPerTick: 1,
    cronIntervalSec: 60,
    crawlEnqueuePerCron: 5,
    downstreamPollIntervalSec: 600,
    downstreamPollEnqueuePerCron: 10,
    maxCrawlDepth: 5,
    maxGraphDepth: 2,
    maxGraphOutputs: 20,
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
    backfillTxsPerJob: 5,
    backfillMaxTxs: 10000,
    backfillHealAuditIntervalSec: 86400,
    backfillHealAuditPerCron: 1,
    backfillHealTxSlack: 5,
    adminToken: "test",
    seedFilePath: "./config/watchlist.seed.json",
    localWatchlistPath: "./config/watchlist.local.json",
    indexerRebuildMode: false,
    processTxRebuildPriority: JOB_PRIORITY.PROCESS_TX_REBUILD,
  };
}

describe("audit_hacker_backfill", () => {
  it("reopens backfill when chain tx_count exceeds indexed txs plus slack", async () => {
    const address = "bc1qcollector";
    const store = {
      countIndexedTxsForHacker: vi.fn().mockReturnValue(50),
      updateBackfillAudit: vi.fn(),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn(),
      getBackfillState: vi.fn().mockReturnValue({ payload: null, backfillComplete: true }),
      enqueueJob: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressStats: () => Promise<{ chain_stats: { tx_count: number } }> }) => unknown) =>
        fn({
          getAddressStats: async () => ({
            chain_stats: { tx_count: 100 },
          }),
        }),
      ),
    } as unknown as ChainRouter;

    const job = {
      id: 1,
      type: "audit_hacker_backfill",
      payloadJson: JSON.stringify({ address }),
      status: "running",
      priority: 2,
      runAfter: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    } as Job;

    await processJob(store, router, baseConfig(), job);

    expect(store.updateBackfillAudit).toHaveBeenCalledWith(address, 100);
    expect(store.setExpandStatus).toHaveBeenCalledWith(address, "backfilling");
    expect(store.enqueueJob).toHaveBeenCalledWith(
      "backfill_hacker_address",
      { address },
      2,
    );
  });

  it("marks backfill complete when chain and indexed counts align within slack", async () => {
    const address = "bc1qcollector";
    const store = {
      countIndexedTxsForHacker: vi.fn().mockReturnValue(100),
      updateBackfillAudit: vi.fn(),
      setExpandStatus: vi.fn(),
      upsertBackfillState: vi.fn(),
      getBackfillState: vi.fn(),
      enqueueJob: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(async (fn: (p: { getAddressStats: () => Promise<{ chain_stats: { tx_count: number } }> }) => unknown) =>
        fn({
          getAddressStats: async () => ({
            chain_stats: { tx_count: 102 },
          }),
        }),
      ),
    } as unknown as ChainRouter;

    const job = {
      id: 2,
      type: "audit_hacker_backfill",
      payloadJson: JSON.stringify({ address }),
      status: "running",
      priority: 2,
      runAfter: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    } as Job;

    await processJob(store, router, baseConfig(), job);

    expect(store.upsertBackfillState).toHaveBeenCalledWith(address, null, true);
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});
