import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import {
  ingestSourceHacker,
  partitionSourceHackers,
  partitionSourceMissing,
  sourceDeltaEmpty,
} from "./sourceDelta.js";

describe("sourceDelta partitions", () => {
  it("splits new and promote hackers from already-flagged", () => {
    const existing = new Map([
      ["bc1qflagged", { isFlaggedHacker: true }],
      ["bc1qdown", { isFlaggedHacker: false }],
    ]);
    const { ingest, knownFlagged } = partitionSourceHackers(
      ["bc1qflagged", "bc1qdown", "bc1qnew"],
      existing,
    );
    expect(knownFlagged).toEqual(["bc1qflagged"]);
    expect(ingest).toEqual(["bc1qdown", "bc1qnew"]);
  });

  it("splits missing victims from rows that already exist", () => {
    const existing = new Map([["bc1qknown", { isFlaggedHacker: false }]]);
    const { missing, known } = partitionSourceMissing(["bc1qknown", "bc1qnew"], existing);
    expect(known).toEqual(["bc1qknown"]);
    expect(missing).toEqual(["bc1qnew"]);
  });

  it("sourceDeltaEmpty is true only when every list is empty", () => {
    expect(sourceDeltaEmpty({})).toBe(true);
    expect(sourceDeltaEmpty({ hackers: ["bc1q"] })).toBe(false);
    expect(sourceDeltaEmpty({ victims: ["bc1q"] })).toBe(false);
    expect(sourceDeltaEmpty({ downstream: ["bc1q"] })).toBe(false);
  });
});

describe("ingestSourceHacker", () => {
  async function freshStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return new Store(db);
  }

  it("inserts a new hacker and enqueues backfill", async () => {
    const store = await freshStore();
    const ok = await ingestSourceHacker(store, "bc1qnewhacker", "coldcardwatch");
    expect(ok).toBe(true);
    expect((await store.getAddress("bc1qnewhacker"))?.isFlaggedHacker).toBe(true);
    expect(await store.hasPendingJob("backfill_hacker_address", "bc1qnewhacker")).toBe(true);
  });

  it("promotes an existing downstream address and enqueues backfill", async () => {
    const store = await freshStore();
    await store.insertAddressIfMissing({
      address: "bc1qdown",
      role: "downstream",
      expandStatus: "expanded",
    });
    const ok = await ingestSourceHacker(store, "bc1qdown", "coldcard_hack_tracker");
    expect(ok).toBe(true);
    const row = await store.getAddress("bc1qdown");
    expect(row?.isFlaggedHacker).toBe(true);
    expect(row?.role).toBe("hacker");
    expect(await store.hasPendingJob("backfill_hacker_address", "bc1qdown")).toBe(true);
  });

  it("skips already-flagged hackers without enqueueing poll or a second backfill", async () => {
    const store = await freshStore();
    await ingestSourceHacker(store, "bc1qflagged", "coldcardwatch");
    const firstJobs = await store.countActiveJobs("backfill_hacker_address");
    const ok = await ingestSourceHacker(store, "bc1qflagged", "coldcardwatch");
    expect(ok).toBe(false);
    expect(await store.countActiveJobs("backfill_hacker_address")).toBe(firstJobs);
    expect(await store.hasPendingJob("poll_hacker_address", "bc1qflagged")).toBe(false);
  });
});
