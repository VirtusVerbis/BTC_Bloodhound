import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { addHacker, clearQueue, removeHacker } from "./hackers.js";

const H1 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const H2 = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
const V1 = "bc1qvictimaaaaaaaaaaaaaaaaaaaaaaaaaaa0001";
const V2 = "bc1qvictimbbbbbbbbbbbbbbbbbbbbbbbbbb0002";
const D1 = "bc1qdown1aaaaaaaaaaaaaaaaaaaaaaaaaaa0001";
const D2 = "bc1qdown2aaaaaaaaaaaaaaaaaaaaaaaaaaa0002";
const SHARED = "bc1qsharedsinkaaaaaaaaaaaaaaaaaaaaaa0001";

async function freshStore() {
  const { sqlite, db } = openDatabase(":memory:");
  runMigrations(sqlite);
  return new Store(db);
}

describe("addHacker / clearQueue / removeHacker", () => {
  it("upserts flagged hacker and enqueues backfill", async () => {
    const store = await freshStore();
    const r = await addHacker(store, { address: H1, label: "ops test" });
    expect(r.enqueuedBackfill).toBe(true);
    const addr = await store.getAddress(H1);
    expect(addr?.isFlaggedHacker).toBe(true);
    expect(addr?.source).toBe("ops");
    expect(addr?.label).toBe("ops test");
    expect(await store.hasPendingJob("backfill_hacker_address", H1)).toBe(true);
  });

  it("uses custom source when provided", async () => {
    const store = await freshStore();
    await addHacker(store, { address: H2, label: "manual add", source: "admin" });
    const addr = await store.getAddress(H2);
    expect(addr?.source).toBe("admin");
    expect(addr?.label).toBe("manual add");
  });

  it("does not enqueue duplicate active backfill", async () => {
    const store = await freshStore();
    await addHacker(store, { address: H1 });
    const r2 = await addHacker(store, { address: H1 });
    expect(r2.enqueuedBackfill).toBe(false);
    expect(await store.countActiveJobs("backfill_hacker_address")).toBe(1);
  });

  it("clearQueue removes pending/running only", async () => {
    const store = await freshStore();
    const doneId = await store.enqueueJob("refresh_btc_usd_price", {}, 1);
    await store.completeJob(doneId);
    await store.enqueueJob("poll_hacker_address", { address: H1 }, 1);
    await store.enqueueJob("process_tx", { txid: "x" }, 1);
    const claimed = await store.claimNextJob();
    expect(claimed?.status).toBe("running");

    const first = await clearQueue(store);
    expect(first.deleted).toBe(2);
    expect(first.pending + first.running).toBe(2);
    expect(first.expandStatusesReset).toBe(0);
    expect(first.queueSchedulingUnpaused).toBe(false);
    expect(first.tickLeaseCleared).toBe(false);
    expect((await store.getJob(doneId))?.status).toBe("done");

    const second = await clearQueue(store);
    expect(second.deleted).toBe(0);
  });

  it("clearQueue resets expand scheduling state and scheduler latches", async () => {
    const store = await freshStore();

    await store.upsertAddress({ address: D1, role: "downstream", expandStatus: "queued" });
    await store.upsertAddress({ address: D2, role: "downstream", expandStatus: "expanding" });
    await store.upsertAddress({ address: SHARED, role: "downstream", expandStatus: "expanded" });
    await store.enqueueJob("expand_downstream", { address: D1, cron: true }, JOB_PRIORITY.CRON_EXPAND);

    await store.setQueueSchedulingPaused(true);
    await store.tryAcquireTickLease(60_000);

    const result = await clearQueue(store);

    expect(result.deleted).toBe(1);
    expect(result.expandStatusesReset).toBe(2);
    expect(result.queueSchedulingUnpaused).toBe(true);
    expect(result.tickLeaseCleared).toBe(true);
    expect((await store.getAddress(D1))?.expandStatus).toBe("pending");
    expect((await store.getAddress(D2))?.expandStatus).toBe("pending");
    expect((await store.getAddress(SHARED))?.expandStatus).toBe("expanded");
    expect(await store.isQueueSchedulingPaused()).toBe(false);
    const state = await store.getSchedulerState();
    expect(state?.tickLeaseUntil).toBeNull();
  });

  it("remove soft-unflags and cancels jobs", async () => {
    const store = await freshStore();
    await addHacker(store, { address: H1 });
    await store.enqueueJob("poll_hacker_address", { address: H1 }, JOB_PRIORITY.POLL_HACKER);
    const r = await removeHacker(store, H1, { pruneExclusive: false });
    expect(r.unflagged).toBe(true);
    expect(r.jobsCancelled).toBeGreaterThanOrEqual(1);
    expect((await store.getAddress(H1))?.isFlaggedHacker).toBe(false);
    expect(await store.hasPendingJob("backfill_hacker_address", H1)).toBe(false);
  });

  it("prunes exclusive victim but keeps shared victim", async () => {
    const store = await freshStore();
    await store.upsertAddress({ address: H1, role: "hacker", isFlaggedHacker: true, hopFromHacker: 0 });
    await store.upsertAddress({ address: H2, role: "hacker", isFlaggedHacker: true, hopFromHacker: 0 });
    await store.upsertAddress({ address: V1, role: "victim" });
    await store.upsertAddress({ address: V2, role: "victim" });
    await store.upsertEdge({
      fromAddress: V1,
      toAddress: H1,
      txid: "t1",
      amountSats: 100,
      direction: "in_to_hacker",
    });
    await store.upsertEdge({
      fromAddress: V2,
      toAddress: H1,
      txid: "t2",
      amountSats: 200,
      direction: "in_to_hacker",
    });
    await store.upsertEdge({
      fromAddress: V2,
      toAddress: H2,
      txid: "t3",
      amountSats: 50,
      direction: "in_to_hacker",
    });

    const r = await removeHacker(store, H1);
    expect(r.unflagged).toBe(true);
    expect(r.victimsPruned).toBe(1);
    expect(await store.getAddress(V1)).toBeUndefined();
    expect(await store.getAddress(V2)).toBeTruthy();
    expect((await store.getAddress(H1))?.isFlaggedHacker).toBe(false);
  });

  it("prunes private downstream chain but keeps shared sink", async () => {
    const store = await freshStore();
    await store.upsertAddress({ address: H1, role: "hacker", isFlaggedHacker: true, hopFromHacker: 0 });
    await store.upsertAddress({ address: H2, role: "hacker", isFlaggedHacker: true, hopFromHacker: 0 });
    await store.upsertAddress({ address: D1, role: "unknown", hopFromHacker: 1 });
    await store.upsertAddress({ address: D2, role: "unknown", hopFromHacker: 2 });
    await store.upsertAddress({ address: SHARED, role: "unknown", hopFromHacker: 1 });

    await store.upsertEdge({
      fromAddress: H1,
      toAddress: D1,
      txid: "o1",
      amountSats: 10,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: D1,
      toAddress: D2,
      txid: "o2",
      amountSats: 9,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: H1,
      toAddress: SHARED,
      txid: "o3",
      amountSats: 5,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: H2,
      toAddress: SHARED,
      txid: "o4",
      amountSats: 7,
      direction: "out_from_hacker",
    });

    const r = await removeHacker(store, H1);
    expect(r.downstreamPruned).toBe(2);
    expect(await store.getAddress(D1)).toBeUndefined();
    expect(await store.getAddress(D2)).toBeUndefined();
    expect(await store.getAddress(SHARED)).toBeTruthy();
  });
});
