import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";

describe("Store cron indexer pause", () => {
  it("setCronIndexerPaused and isCronIndexerPaused", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    expect(await store.isCronIndexerPaused()).toBe(false);
    await store.setCronIndexerPaused(true);
    expect(await store.isCronIndexerPaused()).toBe(true);
    await store.setCronIndexerPaused(false);
    expect(await store.isCronIndexerPaused()).toBe(false);
  });
});
