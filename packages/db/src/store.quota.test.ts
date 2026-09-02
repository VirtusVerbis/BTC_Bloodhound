import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("quota counters", () => {
  it("rolls over counters on UTC day change", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    sqlite
      .prepare(
        `UPDATE scheduler_state SET quota_day_utc = '2026-08-31', d1_rows_read_total = 999, d1_rows_read_cron = 500 WHERE id = 1`,
      )
      .run();

    const snap = await store.getQuotaSnapshot();
    expect(snap.rowsReadTotal).toBe(0);
    expect(snap.rowsReadCron).toBe(0);
    expect(snap.quotaDayUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("flushQuotaUsage increments api and cron columns separately", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.flushQuotaUsage("api", { reads: 10, writes: 2, requests: 1 });
    await store.flushQuotaUsage("cron", { reads: 100, writes: 5, requests: 1 });

    const snap = await store.getQuotaSnapshot();
    expect(snap.rowsReadTotal).toBe(110);
    expect(snap.rowsWrittenTotal).toBe(7);
    expect(snap.workersRequestsTotal).toBe(2);
    expect(snap.rowsReadCron).toBe(100);
    expect(snap.rowsWrittenCron).toBe(5);
    expect(snap.workersRequestsCron).toBe(1);
  });

  it("getD1QuotaStatus includes usage and limits", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.flushQuotaUsage("api", { reads: 42, writes: 0, requests: 0 });

    const status = await store.getD1QuotaStatus({
      rowsReadLimit: 5_000_000,
      rowsWrittenLimit: 100_000,
      workersRequestsLimit: 100_000,
    });
    expect(status.rowsRead).toBe(42);
    expect(status.rowsReadLimit).toBe(5_000_000);
    expect(status.blocked).toBe(false);
  });
});
