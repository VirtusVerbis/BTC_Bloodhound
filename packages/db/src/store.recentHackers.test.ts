import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("recent hackers buffer", () => {
  let store: Store;

  beforeEach(() => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    store = new Store(db);
  });

  it("flushRecentHackerActivity skips D1 write when buffer empty", async () => {
    expect(await store.flushRecentHackerActivity(5)).toBe(false);
  });

  it("records and flushes recent hacker activity", async () => {
    store.recordRecentHackerActivity("bc1qhacker", {
      victims: 1,
      at: "2025-06-01T00:00:00.000Z",
    });
    expect(await store.flushRecentHackerActivity(5)).toBe(true);

    const recent = await store.getRecentHackersActivity();
    expect(recent).toEqual([
      { address: "bc1qhacker", at: "2025-06-01T00:00:00.000Z", victims: 1, downstream: 0 },
    ]);
  });

  it("flushRecentHackerActivity skips write when merge is unchanged", async () => {
    store.recordRecentHackerActivity("bc1qhacker", {
      victims: 1,
      at: "2025-06-01T00:00:00.000Z",
    });
    await store.flushRecentHackerActivity(5);

    store.recordRecentHackerActivity("bc1qhacker", {
      victims: 0,
      at: "2025-06-01T00:00:00.000Z",
    });
    expect(await store.flushRecentHackerActivity(5)).toBe(false);
  });

  it("getRecentHackersActivity returns all stored entries", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const activityStore = new Store(db);
    sqlite
      .prepare("UPDATE scheduler_state SET recent_hackers_json = ? WHERE id = 1")
      .run(
        JSON.stringify([
          { address: "old", at: "2020-01-01T00:00:00.000Z", victims: 1, downstream: 0 },
          { address: "new", at: "2026-08-27T00:00:00.000Z", victims: 1, downstream: 0 },
        ]),
      );

    const recent = await activityStore.getRecentHackersActivity();
    expect(recent.map((e) => e.address).sort()).toEqual(["new", "old"]);
  });
});
