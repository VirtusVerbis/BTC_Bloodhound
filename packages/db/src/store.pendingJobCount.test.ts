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
