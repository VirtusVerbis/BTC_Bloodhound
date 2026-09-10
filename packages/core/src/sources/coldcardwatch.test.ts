import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { SKIPPED_MIN_STATUS } from "../graph/expandSkip.js";
import { applyColdcardWatchSync, applyColdcardWatchSyncBatch } from "./coldcardwatch.js";

async function freshStore() {
  const { sqlite, db } = openDatabase(":memory:");
  runMigrations(sqlite);
  return new Store(db);
}

describe("applyColdcardWatchSync downstream floor", () => {
  it("inserts new downstream as skipped_min without expand_downstream, and backfills collectors", async () => {
    const store = await freshStore();

    await applyColdcardWatchSync(
      store,
      {
        collectors: ["bc1qcollector"],
        victims: ["bc1qvictim"],
        downstream: ["bc1qdown"],
        contentHash: "hash1",
      },
      100_000,
    );

    expect((await store.getAddress("bc1qdown"))?.expandStatus).toBe(SKIPPED_MIN_STATUS);
    expect(await store.hasPendingJob("expand_downstream", "bc1qdown")).toBe(false);
    expect(await store.hasPendingJob("backfill_hacker_address", "bc1qcollector")).toBe(true);
    expect((await store.getAddress("bc1qvictim"))?.role).toBe("victim");
  });

  it("does not clobber an existing downstream expand status", async () => {
    const store = await freshStore();
    await store.insertAddressIfMissing({
      address: "bc1qdown",
      role: "downstream",
      expandStatus: "expanded",
    });

    await applyColdcardWatchSyncBatch(
      store,
      { contentHash: "hash2", downstream: ["bc1qdown"] },
      { minExpandSats: 100_000 },
    );

    expect((await store.getAddress("bc1qdown"))?.expandStatus).toBe("expanded");
    expect(await store.hasPendingJob("expand_downstream", "bc1qdown")).toBe(false);
  });
});
