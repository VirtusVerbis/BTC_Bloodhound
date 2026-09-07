import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

const ADDR_A = "bc1pugaqpaqvynrj78ucpv29swhyrhw7u7e293g0su75vg5zyst8yccqd27f9f";
const ADDR_B = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

async function freshStore() {
  const { sqlite, db } = openDatabase(":memory:");
  runMigrations(sqlite);
  return new Store(db);
}

describe("bumpPendingExpandDownstream", () => {
  it("bumps priority and stamps ops fields on pending job for matching address only", async () => {
    const store = await freshStore();
    const idA = await store.enqueueJob(
      "expand_downstream",
      { address: ADDR_A, continuation: true },
      5,
    );
    const idB = await store.enqueueJob(
      "expand_downstream",
      { address: ADDR_B, continuation: true },
      5,
    );

    const result = await store.bumpPendingExpandDownstream(ADDR_A, 11);

    expect(result).toEqual({ updated: 1, jobIds: [idA] });
    const jobA = await store.getJob(idA);
    const jobB = await store.getJob(idB);
    expect(jobA?.priority).toBe(11);
    expect(JSON.parse(jobA!.payloadJson)).toEqual({
      address: ADDR_A,
      continuation: true,
      ops: true,
      opsPriority: 11,
    });
    expect(jobB?.priority).toBe(5);
    expect(JSON.parse(jobB!.payloadJson)).not.toHaveProperty("ops");
  });

  it("does not update running jobs", async () => {
    const store = await freshStore();
    const id = await store.enqueueJob("expand_downstream", { address: ADDR_A }, 5);
    const claimed = await store.claimNextJob();
    expect(claimed?.id).toBe(id);

    const result = await store.bumpPendingExpandDownstream(ADDR_A, 11);

    expect(result).toEqual({ updated: 0, jobIds: [] });
    expect((await store.getJob(id))?.priority).toBe(5);
  });

  it("returns zero when no matching jobs", async () => {
    const store = await freshStore();
    const result = await store.bumpPendingExpandDownstream(ADDR_A, 11);
    expect(result).toEqual({ updated: 0, jobIds: [] });
  });
});
