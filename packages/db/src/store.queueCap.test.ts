import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("queue cap", () => {
  function openStore(maxQueueDepth = 3) {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return new Store(db, { maxQueueDepth });
  }

  it("blocks enqueue when pending depth reaches maxQueueDepth and sets latch", async () => {
    const store = openStore(3);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, 1);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qb" }, 1);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qc" }, 1);

    const blocked = await store.enqueueJob("poll_hacker_address", { address: "bc1qd" }, 1);
    expect(blocked).toBeNull();
    expect(await store.getQueueDepth()).toBe(3);
    expect(await store.isQueueSchedulingPaused()).toBe(true);
  });

  it("allows ingest continuation jobs while scheduling is paused", async () => {
    const store = openStore(2);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, 1);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qb" }, 1);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qc" }, 1);
    expect(await store.isQueueSchedulingPaused()).toBe(true);

    const contId = await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qx", chainCursor: "txabc", pendingTxids: ["tx1"] },
      10,
    );
    expect(contId).not.toBeNull();
    expect(await store.getQueueDepth()).toBe(3);
  });

  it("clears latch when queue drains to zero", async () => {
    const store = openStore(2);
    const id1 = (await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, 1))!;
    const id2 = (await store.enqueueJob("poll_hacker_address", { address: "bc1qb" }, 1))!;
    await store.enqueueJob("poll_hacker_address", { address: "bc1qc" }, 1);
    expect(await store.isQueueSchedulingPaused()).toBe(true);

    await store.completeJob(id1);
    await store.maybeClearQueueSchedulingPause();
    expect(await store.isQueueSchedulingPaused()).toBe(true);

    await store.completeJob(id2);
    await store.maybeClearQueueSchedulingPause();
    expect(await store.getQueueDepth()).toBe(0);
    expect(await store.isQueueSchedulingPaused()).toBe(false);
  });

  it("records per-provider API thresholds", async () => {
    const store = openStore();
    const future = new Date(Date.now() + 300_000).toISOString();
    await store.recordApiThreshold("esplora", { retryAfterAt: future, strikeCount: 1 });
    await store.recordApiThreshold("mempool", { retryAfterAt: future, strikeCount: 2 });

    const status = await store.getMonitoringStatus(600, 300);
    expect(status.chainApis).toHaveLength(2);
    expect(status.chainApis![0]!.thresholdExceeded).toBe(true);
    expect(status.chainApis![0]!.strikeCount).toBe(1);
    expect(status.chainApis![1]!.thresholdExceeded).toBe(true);
    expect(status.chainApis![1]!.strikeCount).toBe(2);
    expect(status.apiThresholdExceeded).toBe(true);
    expect(status.apiThresholdSecondsLeft).toBeGreaterThan(0);
  });

  it("clears provider strike and retry window on success", async () => {
    const store = openStore();
    const future = new Date(Date.now() + 300_000).toISOString();
    await store.recordApiThreshold("esplora", { retryAfterAt: future, strikeCount: 3 });
    expect(store.isProviderInBackoff(await store.getSchedulerState(), "esplora")).toBe(true);

    await store.clearProviderStrike("esplora");
    const state = await store.getSchedulerState();
    expect(state?.esploraStrikeCount).toBe(0);
    expect(state?.esploraRetryAfterAt).toBeNull();
    expect(store.isProviderInBackoff(state, "esplora")).toBe(false);
  });

  it("hasAvailableChainProvider is true unless both providers are in backoff", async () => {
    const store = openStore();
    const future = new Date(Date.now() + 300_000).toISOString();

    expect(store.hasAvailableChainProvider(await store.getSchedulerState())).toBe(true);

    await store.recordApiThreshold("esplora", { retryAfterAt: future, strikeCount: 1 });
    expect(store.hasAvailableChainProvider(await store.getSchedulerState())).toBe(true);

    await store.recordApiThreshold("mempool", { retryAfterAt: future, strikeCount: 1 });
    expect(store.hasAvailableChainProvider(await store.getSchedulerState())).toBe(false);
  });
});
