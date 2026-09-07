import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { JOB_PRIORITY } from "../config.js";
import { validVectorByLabel } from "../util/addressVectors.js";
import { enqueueExpandDownstream, bumpExpandDownstream } from "./expand.js";

const D1 = validVectorByLabel("P2TR bc1p prod downstream").expected;

async function freshStore() {
  const { sqlite, db } = openDatabase(":memory:");
  runMigrations(sqlite);
  return new Store(db);
}

describe("enqueueExpandDownstream", () => {
  it("enqueues expand_downstream with default priority and sets expand_status queued", async () => {
    const store = await freshStore();
    await store.upsertAddress({ address: D1, role: "downstream" });

    const result = await enqueueExpandDownstream(store, { address: D1 });

    expect(result).toEqual({
      address: D1,
      enqueued: true,
      jobId: expect.any(Number),
      priority: JOB_PRIORITY.CRON_EXPAND,
    });
    const row = await store.getAddress(D1);
    expect(row?.expandStatus).toBe("queued");
    const job = await store.getJob(result.jobId!);
    expect(job?.priority).toBe(JOB_PRIORITY.CRON_EXPAND);
    expect(JSON.parse(job!.payloadJson)).toEqual({ address: D1, ops: true, opsPriority: JOB_PRIORITY.CRON_EXPAND });
    expect(await store.hasPendingJob("expand_downstream", D1)).toBe(true);
  });

  it("uses custom priority 11", async () => {
    const store = await freshStore();
    await store.upsertAddress({ address: D1, role: "downstream" });

    const result = await enqueueExpandDownstream(store, { address: D1, priority: 11 });

    expect(result.enqueued).toBe(true);
    expect(result.priority).toBe(11);
    const job = await store.getJob(result.jobId!);
    expect(job?.priority).toBe(11);
    expect(JSON.parse(job!.payloadJson)).toEqual({ address: D1, ops: true, opsPriority: 11 });
  });

  it("dedupes active expand_downstream for the same address", async () => {
    const store = await freshStore();
    await store.upsertAddress({ address: D1, role: "downstream" });

    const first = await enqueueExpandDownstream(store, { address: D1 });
    const second = await enqueueExpandDownstream(store, { address: D1 });

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.message).toMatch(/already queued or running/i);
    expect(await store.countActiveJobs("expand_downstream")).toBe(1);
  });

  it("returns no-op when address is not in database", async () => {
    const store = await freshStore();

    const result = await enqueueExpandDownstream(store, { address: D1 });

    expect(result).toEqual({
      address: D1,
      enqueued: false,
      jobId: null,
      priority: JOB_PRIORITY.CRON_EXPAND,
      message: "Address not in database",
    });
  });

  it("rejects invalid priority", async () => {
    const store = await freshStore();
    await store.upsertAddress({ address: D1, role: "downstream" });

    await expect(enqueueExpandDownstream(store, { address: D1, priority: 0 })).rejects.toThrow(
      /Invalid priority/,
    );
  });

  it("rejects invalid address", async () => {
    const store = await freshStore();

    await expect(enqueueExpandDownstream(store, { address: "not-a-btc-address" })).rejects.toThrow(
      /Invalid Bitcoin address/,
    );
  });
});

describe("bumpExpandDownstream", () => {
  it("bumps pending expand_downstream for address", async () => {
    const store = await freshStore();
    await store.upsertAddress({ address: D1, role: "downstream" });
    const enqueued = await store.enqueueJob("expand_downstream", { address: D1, continuation: true }, 5);

    const result = await bumpExpandDownstream(store, { address: D1 });

    expect(result).toEqual({
      address: D1,
      updated: 1,
      jobIds: [enqueued],
      priority: JOB_PRIORITY.PROCESS_TX_REBUILD,
    });
    const job = await store.getJob(enqueued);
    expect(job?.priority).toBe(JOB_PRIORITY.PROCESS_TX_REBUILD);
    expect(JSON.parse(job!.payloadJson)).toEqual({
      address: D1,
      continuation: true,
      ops: true,
      opsPriority: JOB_PRIORITY.PROCESS_TX_REBUILD,
    });
  });

  it("uses custom priority", async () => {
    const store = await freshStore();
    await store.enqueueJob("expand_downstream", { address: D1 }, 5);

    const result = await bumpExpandDownstream(store, { address: D1, priority: 10 });

    expect(result.priority).toBe(10);
    expect(result.updated).toBe(1);
  });

  it("returns message when no matching job", async () => {
    const store = await freshStore();

    const result = await bumpExpandDownstream(store, { address: D1 });

    expect(result.updated).toBe(0);
    expect(result.message).toMatch(/no pending or running/i);
  });

  it("rejects invalid address", async () => {
    const store = await freshStore();

    await expect(bumpExpandDownstream(store, { address: "bad" })).rejects.toThrow(/Invalid Bitcoin address/);
  });
});
