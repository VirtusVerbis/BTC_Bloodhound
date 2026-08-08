import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("listDownstreamForPoll", () => {
  it("orders never-polled before recently polled", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "recent",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "stale",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertSyncState("recent", { lastSeenTxid: "tx1" });
    sqlite
      .prepare("UPDATE sync_state SET last_polled_at = ? WHERE address = ?")
      .run("2020-01-01T00:00:00.000Z", "recent");

    const due = await store.listDownstreamForPoll(10, 5, 600);
    expect(due.map((r) => r.address)).toEqual(["stale", "recent"]);
  });

  it("excludes nodes at max crawl depth", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "deep",
      role: "downstream",
      hopFromHacker: 5,
      expandStatus: "expanded",
    });

    const due = await store.listDownstreamForPoll(10, 5, 600);
    expect(due).toHaveLength(0);
  });
});
