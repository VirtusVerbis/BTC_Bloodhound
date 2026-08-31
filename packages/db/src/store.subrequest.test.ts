import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations } from "./index.js";
import { createD1Store, instrumentD1Binding, type D1Binding } from "./d1.js";
import { Store } from "./store.js";

function createBudget() {
  let used = 0;
  return {
    canConsume: vi.fn((n = 1) => used + n <= 50),
    consume: vi.fn((n = 1) => {
      used += n;
    }),
    used: () => used,
  };
}

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
              return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
            },
            all: async () => ({ success: true, results: bound.all() }),
            first: async () => {
              const row = bound.get();
              return { success: true, results: row != null ? [row] : [] };
            },
            raw: async (pluralizeColumns?: unknown) =>
              bound.raw(typeof pluralizeColumns === "boolean" ? pluralizeColumns : false),
          };
        },
      };
    },
    batch: async (statements: unknown[]) => {
      for (const bound of statements as Array<{ run(): Promise<unknown> }>) {
        await bound.run();
      }
      return statements.map(() => ({}));
    },
    exec: async (query: string) => {
      sqlite.exec(query);
      return {};
    },
  };
}

describe("instrumentD1Binding", () => {
  it("counts terminal executes and batch, not bind alone", async () => {
    let count = 0;
    const sink = (n = 1) => {
      count += n;
    };
    const d1 = instrumentD1Binding(
      {
        prepare: () => ({
          bind: () => ({
            run: async () => ({}),
            all: async () => [],
            first: async () => null,
          }),
        }),
        batch: async (statements) => statements.map(() => ({})),
        exec: async () => ({}),
      },
      sink,
    );

    d1.prepare("SELECT 1").bind();
    expect(count).toBe(0);

    await (d1.prepare("SELECT 1") as { bind(): { run(): Promise<unknown> } }).bind().run();
    expect(count).toBe(1);

    await d1.batch?.([{}]);
    expect(count).toBe(2);

    await d1.exec?.("SELECT 1");
    expect(count).toBe(3);
  });

  it("records rows_read and rows_written into rowMeter", async () => {
    const { D1RowMeter } = await import("./d1RowMeter.js");
    const meter = new D1RowMeter("2026-08-31");
    const d1 = instrumentD1Binding(
      {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ meta: { rows_read: 10, rows_written: 2 } }),
            all: async () => ({ meta: { rows_read: 5, rows_written: 1 } }),
            first: async () => ({ meta: { rows_read: 3, rows_written: 0 } }),
          }),
        }),
      },
      { rowMeter: meter },
    );

    await (d1.prepare("SELECT 1") as { bind(): { run(): Promise<unknown> } }).bind().run();
    await (d1.prepare("SELECT 1") as { bind(): { all(): Promise<unknown> } }).bind().all();
    expect(meter.snapshot().rowsRead).toBe(15);
    expect(meter.snapshot().rowsWritten).toBe(3);
  });
});

describe("Store subrequest metering", () => {
  it("does not increment local Store without d1 binding", async () => {
    const budget = createBudget();
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db, { subrequestBudget: budget });

    await store.getQueueDepth();
    expect(budget.consume).not.toHaveBeenCalled();
  });

  it("increments budget on D1 drizzle queries via createD1Store", async () => {
    const budget = createBudget();
    const { sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = createD1Store(createSqliteD1(sqlite), { subrequestBudget: budget });

    await store.getQueueDepth();
    expect(budget.used()).toBeGreaterThan(0);
  });

  it("counts batch upserts once per d1.batch call", async () => {
    const budget = createBudget();
    const { sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = createD1Store(createSqliteD1(sqlite), {
      subrequestBudget: budget,
      d1BatchSize: 4,
    });

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qv1",
        toAddress: "bc1qh1",
        txid: "tx1",
        amountSats: 100,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qv1",
        toAddress: "bc1qh2",
        txid: "tx2",
        amountSats: 200,
        direction: "out_from_hacker",
      },
    ]);

    expect(budget.used()).toBeGreaterThanOrEqual(1);
  });

  it("counts claimNextJob select and update", async () => {
    const budget = createBudget();
    const { sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = createD1Store(createSqliteD1(sqlite), { subrequestBudget: budget });
    const ts = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO jobs (type, payload_json, status, priority, run_after, created_at)
         VALUES ('expand_downstream', '{}', 'pending', 1, ?, ?)`,
      )
      .run(ts, ts);

    const before = budget.used();
    await store.claimNextJob();
    expect(budget.used()).toBeGreaterThan(before);
  });
});
