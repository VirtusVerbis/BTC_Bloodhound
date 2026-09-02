import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("queue cap", () => {
  function openStore(
    opts?: {
      maxQueueDepth?: number;
      queueSchedulingResumeDepth?: number;
      maxPendingExpandPerAddress?: number;
      maxPendingExpandGlobal?: number;
    },
  ) {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const maxQueueDepth = opts?.maxQueueDepth ?? 3;
    return new Store(db, {
      maxQueueDepth,
      queueSchedulingResumeDepth:
        opts?.queueSchedulingResumeDepth ?? Math.floor(maxQueueDepth / 2),
      maxPendingExpandPerAddress: opts?.maxPendingExpandPerAddress,
      maxPendingExpandGlobal: opts?.maxPendingExpandGlobal,
    });
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

  it("allows backfill continuation while scheduling is paused but blocks expand continuation", async () => {
    const store = openStore({ maxQueueDepth: 2 });
    await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, 1);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qb" }, 1);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qc" }, 1);
    expect(await store.isQueueSchedulingPaused()).toBe(true);

    const backfillId = await store.enqueueJob(
      "backfill_hacker_address",
      { address: "bc1qx", chainCursor: "txabc", pendingTxids: ["tx1"] },
      10,
    );
    expect(backfillId).not.toBeNull();

    const expandCont = await store.enqueueJob(
      "expand_downstream",
      { address: "bc1qexpand", chainCursor: "txabc", processedIndex: 1 },
      5,
    );
    expect(expandCont).toBeNull();

    const expandNew = await store.enqueueJob(
      "expand_downstream",
      { address: "bc1qexpand", cron: true },
      5,
    );
    expect(expandNew).toBeNull();
  });

  it("clears latch when queue drains below resume depth", async () => {
    const store = openStore({ maxQueueDepth: 6, queueSchedulingResumeDepth: 3 });
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await store.enqueueJob("poll_hacker_address", { address: `bc1q${i}` }, 1);
      expect(id).not.toBeNull();
      ids.push(id!);
    }
    expect(await store.enqueueJob("poll_hacker_address", { address: "bc1qoverflow" }, 1)).toBeNull();
    expect(await store.isQueueSchedulingPaused()).toBe(true);

    await store.completeJob(ids[0]!);
    await store.completeJob(ids[1]!);
    await store.completeJob(ids[2]!);
    await store.maybeClearQueueSchedulingPause();
    expect(await store.getQueueDepth()).toBe(3);
    expect(await store.isQueueSchedulingPaused()).toBe(false);
  });

  it("allows expand continuation at cap edge when not paused", async () => {
    const store = openStore({ maxQueueDepth: 4 });
    for (let i = 0; i < 3; i++) {
      await store.enqueueJob("poll_hacker_address", { address: `bc1q${i}` }, 1);
    }
    expect(await store.isQueueSchedulingPaused()).toBe(false);

    const expandCont = await store.enqueueJob(
      "expand_downstream",
      { address: "bc1qexpand", chainCursor: "txabc", processedIndex: 1 },
      5,
    );
    expect(expandCont).not.toBeNull();
    expect(await store.getQueueDepth()).toBe(4);
  });

  it("blocks expand enqueue when per-address cap is reached", async () => {
    const store = openStore({ maxPendingExpandPerAddress: 2, maxPendingExpandGlobal: 40 });
    await store.enqueueJob("expand_downstream", { address: "bc1qhot" }, 5);
    await store.enqueueJob("expand_downstream", { address: "bc1qhot" }, 5);
    const blocked = await store.enqueueJob("expand_downstream", { address: "bc1qhot" }, 5);
    expect(blocked).toBeNull();
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
