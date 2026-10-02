import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createD1Store, type D1Binding } from "./d1.js";
import { D1RowMeter } from "./d1RowMeter.js";
import { openDatabase, runMigrations } from "./index.js";

function createSqliteD1(sqlite: Database.Database, meter: D1RowMeter): D1Binding {
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
                const rows = bound.raw(true).all();
                meter.record(1, 0);
                return rows;
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

function openStore() {
  const meter = new D1RowMeter();
  const { sqlite } = openDatabase(":memory:");
  runMigrations(sqlite);
  const store = createD1Store(createSqliteD1(sqlite, meter), { d1RowMeter: meter });
  return { meter, store };
}

describe("scheduler state cache", () => {
  it("reads scheduler_state once until the cache is cleared", async () => {
    const { meter, store } = openStore();
    await store.getSchedulerState();
    const afterFirst = meter.snapshot().rowsRead;
    expect(afterFirst).toBeGreaterThan(0);

    await store.getSchedulerState();
    expect(meter.snapshot().rowsRead).toBe(afterFirst);

    store.clearSchedulerStateCache();
    await store.getSchedulerState();
    expect(meter.snapshot().rowsRead).toBe(afterFirst + 1);
  });

  it("serves updateSchedulerState from the cache without another read", async () => {
    const { meter, store } = openStore();
    await store.getSchedulerState();
    const afterWarm = meter.snapshot().rowsRead;

    await store.updateSchedulerState({ rateLimitMs: 4321 });
    const state = await store.getSchedulerState();
    expect(state?.rateLimitMs).toBe(4321);
    expect(meter.snapshot().rowsRead).toBe(afterWarm + 1);
  });

  it("shows an enqueued job's counter bump without rereading scheduler_state", async () => {
    const { meter, store } = openStore();
    await store.getSchedulerState();

    const beforeEnqueue = meter.snapshot().rowsRead;
    await store.enqueueJob("process_tx", { txid: "abc" }, 1);
    const afterEnqueue = meter.snapshot().rowsRead;

    const state = await store.getSchedulerState();
    expect(meter.snapshot().rowsRead).toBe(afterEnqueue);
    expect(afterEnqueue).toBeGreaterThan(beforeEnqueue);
    expect(state?.pendingJobCount).toBe(1);
    expect(state?.activeProcessTxCount).toBe(1);
  });

  it("patches a successful tick lease and leaves the cached lease after a failed acquire", async () => {
    const { meter, store } = openStore();
    await store.getSchedulerState();
    const afterWarm = meter.snapshot().rowsRead;

    expect(await store.tryAcquireTickLease(60_000)).toBe(true);
    const leased = await store.getSchedulerState();
    expect(leased?.tickLeaseUntil).toBeTruthy();
    expect(meter.snapshot().rowsRead).toBe(afterWarm + 1);

    const until = leased?.tickLeaseUntil;
    expect(await store.tryAcquireTickLease(60_000)).toBe(false);
    const still = await store.getSchedulerState();
    expect(still?.tickLeaseUntil).toBe(until);
    expect(meter.snapshot().rowsRead).toBe(afterWarm + 2);
  });
});
