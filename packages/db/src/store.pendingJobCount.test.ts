import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("pending job count", () => {
  async function openStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return { sqlite, store: new Store(db) };
  }

  async function readCounter(store: Store) {
    const state = await store.getSchedulerState();
    return state?.pendingJobCount ?? 0;
  }

  it("starts at zero", async () => {
    const { store } = await openStore();
    expect(await readCounter(store)).toBe(0);
    expect(await store.getPendingQueueDepthAll()).toBe(0);
  });

  it("increments on enqueue and decrements when completing a pending job", async () => {
    const { store } = await openStore();
    const id = await store.enqueueJob("process_tx", { txid: "a" }, 1);
    expect(await readCounter(store)).toBe(1);
    expect(await store.getPendingQueueDepthAll()).toBe(1);
    await store.completeJob(id!);
    expect(await readCounter(store)).toBe(0);
    expect(await store.getPendingQueueDepthAll()).toBe(0);
  });

  it("decrements on claim and increments on fail back to pending", async () => {
    const { store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    const claimed = await store.claimNextJob();
    expect(claimed).not.toBeNull();
    expect(await readCounter(store)).toBe(0);
    await store.failJob(claimed!.id, "boom");
    expect(await readCounter(store)).toBe(1);
    expect(await store.getPendingQueueDepthAll()).toBe(1);
  });

  it("does not change on complete after claim", async () => {
    const { store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    const claimed = await store.claimNextJob();
    expect(await readCounter(store)).toBe(0);
    await store.completeJob(claimed!.id);
    expect(await readCounter(store)).toBe(0);
  });

  it("increments on defer of a running job", async () => {
    const { store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    const claimed = await store.claimNextJob();
    expect(await readCounter(store)).toBe(0);
    const runAfter = new Date(Date.now() + 60_000).toISOString();
    await store.deferJob(claimed!.id, "deferred", runAfter);
    expect(await readCounter(store)).toBe(1);
    expect(await store.getQueueDepth()).toBe(0);
    expect(await store.getPendingQueueDepthAll()).toBe(1);
  });

  it("increments when reclaiming a running job", async () => {
    const { store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    await store.claimNextJob();
    expect(await readCounter(store)).toBe(0);
    const { reclaimed } = await store.resetRunningJobs();
    expect(reclaimed).toBe(1);
    expect(await readCounter(store)).toBe(1);
  });

  it("decrements when deleting pending jobs for an address", async () => {
    const { store } = await openStore();
    await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, 1);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qb" }, 1);
    expect(await readCounter(store)).toBe(2);
    await store.deleteActiveJobsForAddress("bc1qa");
    expect(await readCounter(store)).toBe(1);
  });

  it("resets to zero when deleting all active jobs", async () => {
    const { store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    await store.enqueueJob("process_tx", { txid: "b" }, 1);
    await store.deleteActiveJobs();
    expect(await readCounter(store)).toBe(0);
    expect(await store.getPendingQueueDepthAll()).toBe(0);
  });

  it("reconcilePendingJobCount repairs drift", async () => {
    const { sqlite, store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    sqlite.prepare("UPDATE scheduler_state SET pending_job_count = 0 WHERE id = 1").run();
    expect(await readCounter(store)).toBe(0);
    expect(await store.reconcilePendingJobCount()).toBe(1);
    expect(await readCounter(store)).toBe(1);
  });

  it("does not increment when enqueueIfAbsent skips a duplicate", async () => {
    const { store } = await openStore();
    const first = await store.enqueueJobIfAbsent("sync_coldcardwatch", {}, 5);
    const second = await store.enqueueJobIfAbsent("sync_coldcardwatch", {}, 5);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await readCounter(store)).toBe(1);
  });
});

describe("active job type counters", () => {
  async function openStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return { sqlite, store: new Store(db) };
  }

  async function readActive(store: Store) {
    const state = await store.getSchedulerState();
    return {
      expand: state?.activeExpandCount ?? 0,
      backfill: state?.activeBackfillCount ?? 0,
      audit: state?.activeAuditCount ?? 0,
      processTx: state?.activeProcessTxCount ?? 0,
    };
  }

  it("increments on enqueue and is unchanged by claim or fail", async () => {
    const { store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    expect(await readActive(store)).toEqual({ expand: 0, backfill: 0, audit: 0, processTx: 1 });
    expect(await store.countActiveJobs("process_tx")).toBe(1);

    const claimed = await store.claimNextJob();
    expect(claimed).not.toBeNull();
    expect(await readActive(store)).toEqual({ expand: 0, backfill: 0, audit: 0, processTx: 1 });

    await store.failJob(claimed!.id, "boom");
    expect(await readActive(store)).toEqual({ expand: 0, backfill: 0, audit: 0, processTx: 1 });
  });

  it("decrements on complete", async () => {
    const { store } = await openStore();
    const id = await store.enqueueJob("expand_downstream", { address: "bc1qa" }, 8);
    expect((await readActive(store)).expand).toBe(1);
    await store.completeJob(id!);
    expect((await readActive(store)).expand).toBe(0);
    expect(await store.countActiveJobs("expand_downstream")).toBe(0);
  });

  it("tracks backfill and audit types separately", async () => {
    const { store } = await openStore();
    await store.enqueueJob("backfill_hacker_address", { address: "bc1qb" }, 10);
    await store.enqueueJob("audit_hacker_backfill", { address: "bc1qc" }, 9);
    expect(await readActive(store)).toEqual({ expand: 0, backfill: 1, audit: 1, processTx: 0 });
  });

  it("reconcileActiveJobCounts repairs drift", async () => {
    const { sqlite, store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    sqlite.prepare("UPDATE scheduler_state SET active_process_tx_count = 0 WHERE id = 1").run();
    expect(await store.countActiveJobs("process_tx")).toBe(0);
    await store.reconcileCheapCounters();
    expect(await store.countActiveJobs("process_tx")).toBe(1);
  });

  it("deleteActiveJobs zeroes cached type counters", async () => {
    const { store } = await openStore();
    await store.enqueueJob("process_tx", { txid: "a" }, 1);
    await store.enqueueJob("expand_downstream", { address: "bc1qa" }, 8);
    await store.deleteActiveJobs();
    expect(await readActive(store)).toEqual({ expand: 0, backfill: 0, audit: 0, processTx: 0 });
  });

  it("deleteActiveJobsForAddress decrements matching type counters", async () => {
    const { store } = await openStore();
    await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, 1);
    await store.enqueueJob("expand_downstream", { address: "bc1qa" }, 8);
    await store.enqueueJob("expand_downstream", { address: "bc1qb" }, 8);
    await store.deleteActiveJobsForAddress("bc1qa");
    expect((await readActive(store)).expand).toBe(1);
  });

  it("does not increment when enqueueIfAbsent skips a duplicate", async () => {
    const { store } = await openStore();
    const first = await store.enqueueJobIfAbsent("backfill_hacker_address", { address: "bc1qd" }, 10);
    const second = await store.enqueueJobIfAbsent("backfill_hacker_address", { address: "bc1qd" }, 10, undefined, {
      address: "bc1qd",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect((await readActive(store)).backfill).toBe(1);
  });
});
