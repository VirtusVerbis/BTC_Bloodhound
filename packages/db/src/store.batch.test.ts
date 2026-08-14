import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations } from "./index.js";
import { Store } from "./store.js";
import type { D1Binding } from "./d1.js";

describe("Store batch upserts", () => {
  it("creates edges_from_to_txid_uq after runMigrations", () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const indexes = sqlite.prepare("PRAGMA index_list(edges)").all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === "edges_from_to_txid_uq")).toBe(true);
    void db;
  });

  it("dedupes edges and batch upserts idempotently", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db, { d1BatchSize: 4 });

    sqlite
      .prepare(
        `INSERT INTO edges (from_address, to_address, txid, amount_sats, direction)
         VALUES ('bc1qv1', 'bc1qh1', 'tx1', 100, 'in_to_hacker')`,
      )
      .run();

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qv1",
        toAddress: "bc1qh1",
        txid: "tx1",
        amountSats: 300,
        direction: "in_to_hacker",
      },
    ]);

    const row = sqlite
      .prepare(`SELECT amount_sats FROM edges WHERE txid = 'tx1' AND from_address = 'bc1qv1'`)
      .get() as { amount_sats: number };
    expect(row.amount_sats).toBe(300);

    const count = sqlite.prepare(`SELECT count(*) as c FROM edges WHERE txid = 'tx1'`).get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it("uses native D1 batch for sql upserts when d1 binding is provided", async () => {
    const batch = vi.fn(async (statements: unknown[]) => statements.map(() => ({})));
    const prepare = vi.fn((sql: string) => ({
      bind: (...params: unknown[]) => ({ sql, params }),
    }));
    const d1: D1Binding = { prepare, batch };

    const { db, sqlite } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db, { d1, d1BatchSize: 4 });

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qv1",
        toAddress: "bc1qh2",
        txid: "tx2",
        amountSats: 500,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qv1",
        toAddress: "bc1qh3",
        txid: "tx3",
        amountSats: 600,
        direction: "out_from_hacker",
      },
    ]);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]![0]).toContain("INSERT INTO edges");
  });
});
