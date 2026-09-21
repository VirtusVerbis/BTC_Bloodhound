import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createD1Store, type D1Binding } from "./d1.js";
import { D1RowMeter } from "./d1RowMeter.js";
import { openDatabase, runMigrations, Store } from "./index.js";

function createSqliteD1(sqlite: Database.Database): D1Binding {
  return {
    prepare(query: string) {
      const stmt = sqlite.prepare(query);
      return {
        bind(...params: unknown[]) {
          const bound = stmt.bind(...params);
          return {
            run: async () => {
              const info = bound.run();
              return {
                success: true,
                meta: {
                  changes: info.changes,
                  last_row_id: Number(info.lastInsertRowid),
                  rows_read: 1,
                  rows_written: info.changes > 0 ? 1 : 0,
                },
              };
            },
            all: async () => ({
              success: true,
              results: bound.all(),
              meta: { rows_read: 1, rows_written: 0 },
            }),
            first: async () => {
              const row = bound.get();
              return {
                success: true,
                results: row != null ? [row] : [],
                meta: { rows_read: 1, rows_written: 0 },
              };
            },
            raw: async () => {
              try {
                return bound.raw(true).all();
              } finally {
                bound.raw(false);
              }
            },
          };
        },
      };
    },
    batch: async (statements: unknown[]) => {
      const results = [];
      for (const bound of statements as Array<{ run(): Promise<unknown> }>) {
        results.push(await bound.run());
      }
      return results;
    },
    exec: async (query: string) => {
      sqlite.exec(query);
      return { meta: { rows_read: 0, rows_written: 0 } };
    },
  };
}

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

  it("flushQuotaUsage persists overhead into totals without inflating app meter", async () => {
    const meter = new D1RowMeter("2026-08-31");
    const { sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = createD1Store(createSqliteD1(sqlite), { d1RowMeter: meter });

    meter.record(50, 5);
    const before = meter.snapshot();
    await store.flushQuotaUsage("api", { reads: 50, writes: 5, requests: 1 });
    expect(meter.snapshot()).toEqual(before);

    const row = sqlite
      .prepare(
        `SELECT d1_rows_read_total, d1_rows_written_total, d1_rows_read_overhead, d1_rows_written_overhead
         FROM scheduler_state WHERE id = 1`,
      )
      .get() as {
      d1_rows_read_total: number;
      d1_rows_written_total: number;
      d1_rows_read_overhead: number;
      d1_rows_written_overhead: number;
    };
    expect(row.d1_rows_read_overhead).toBeGreaterThan(0);
    expect(row.d1_rows_written_overhead).toBeGreaterThan(0);
    expect(row.d1_rows_read_total).toBeGreaterThan(50);
    expect(row.d1_rows_written_total).toBeGreaterThan(5);
    expect(row.d1_rows_read_total).toBe(50 + row.d1_rows_read_overhead);
    expect(row.d1_rows_written_total).toBe(5 + row.d1_rows_written_overhead);
  });

  it("flushQuotaUsage cron slice counts app delta only", async () => {
    const meter = new D1RowMeter("2026-08-31");
    const { sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = createD1Store(createSqliteD1(sqlite), { d1RowMeter: meter });

    meter.record(100, 5);
    await store.flushQuotaUsage("cron", { reads: 100, writes: 5, requests: 1 });

    const row = sqlite
      .prepare(
        `SELECT d1_rows_read_total, d1_rows_read_cron, d1_rows_read_overhead
         FROM scheduler_state WHERE id = 1`,
      )
      .get() as {
      d1_rows_read_total: number;
      d1_rows_read_cron: number;
      d1_rows_read_overhead: number;
    };
    expect(row.d1_rows_read_cron).toBe(100);
    expect(row.d1_rows_read_overhead).toBeGreaterThan(0);
    expect(row.d1_rows_read_total).toBe(100 + row.d1_rows_read_overhead);
  });

  it("rolls over overhead columns on UTC day change", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    sqlite
      .prepare(
        `UPDATE scheduler_state SET quota_day_utc = '2026-08-31', d1_rows_read_overhead = 42, d1_rows_written_overhead = 7 WHERE id = 1`,
      )
      .run();

    await store.getQuotaSnapshot();
    const row = sqlite
      .prepare(
        `SELECT d1_rows_read_overhead, d1_rows_written_overhead FROM scheduler_state WHERE id = 1`,
      )
      .get() as { d1_rows_read_overhead: number; d1_rows_written_overhead: number };
    expect(row.d1_rows_read_overhead).toBe(0);
    expect(row.d1_rows_written_overhead).toBe(0);
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
