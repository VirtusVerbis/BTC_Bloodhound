import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("incremental total_received_sats", () => {
  function openStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return { sqlite, store: new Store(db) };
  }

  it("increments total on new in_to_hacker edge", async () => {
    const { sqlite, store } = openStore();
    const ts = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO addresses (address, role, is_flagged_hacker, created_at, expand_status, total_received_sats)
         VALUES ('bc1qhacker', 'hacker', 1, ?, 'expanded', 1000)`,
      )
      .run(ts);

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qvictim",
        toAddress: "bc1qhacker",
        txid: "tx1",
        amountSats: 500,
        direction: "in_to_hacker",
      },
    ]);

    const row = sqlite
      .prepare(`SELECT total_received_sats FROM addresses WHERE address = 'bc1qhacker'`)
      .get() as { total_received_sats: number };
    expect(row.total_received_sats).toBe(1500);
  });

  it("applies delta when in_to_hacker edge amount changes on conflict", async () => {
    const { sqlite, store } = openStore();
    const ts = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO addresses (address, role, is_flagged_hacker, created_at, expand_status, total_received_sats)
         VALUES ('bc1qhacker', 'hacker', 1, ?, 'expanded', 1000)`,
      )
      .run(ts);
    sqlite
      .prepare(
        `INSERT INTO edges (from_address, to_address, txid, amount_sats, direction)
         VALUES ('bc1qvictim', 'bc1qhacker', 'tx1', 100, 'in_to_hacker')`,
      )
      .run();

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qvictim",
        toAddress: "bc1qhacker",
        txid: "tx1",
        amountSats: 300,
        direction: "in_to_hacker",
      },
    ]);

    const row = sqlite
      .prepare(`SELECT total_received_sats FROM addresses WHERE address = 'bc1qhacker'`)
      .get() as { total_received_sats: number };
    expect(row.total_received_sats).toBe(1200);
  });

  it("does not change total for out_from_hacker edges", async () => {
    const { sqlite, store } = openStore();
    const ts = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO addresses (address, role, is_flagged_hacker, created_at, expand_status, total_received_sats)
         VALUES ('bc1qhacker', 'hacker', 1, ?, 'expanded', 1000)`,
      )
      .run(ts);

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qhacker",
        toAddress: "bc1qdown",
        txid: "txout",
        amountSats: 500,
        direction: "out_from_hacker",
      },
    ]);

    const row = sqlite
      .prepare(`SELECT total_received_sats FROM addresses WHERE address = 'bc1qhacker'`)
      .get() as { total_received_sats: number };
    expect(row.total_received_sats).toBe(1000);
  });
});

describe("D1 quota pause", () => {
  it("tracks read and write retry windows", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    const future = new Date(Date.now() + 3600_000).toISOString();

    await store.setD1QuotaPaused("read", future);
    expect(await store.isD1QuotaBlocked("read")).toBe(true);
    expect(await store.isD1QuotaBlocked("write")).toBe(false);
    expect(await store.isD1QuotaBlocked()).toBe(true);

    const status = await store.getD1QuotaStatus();
    expect(status.readRetryAfterAt).toBe(future);
    expect(status.blocked).toBe(true);
  });

  it("clears expired pause", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    const past = new Date(Date.now() - 1000).toISOString();
    await store.setD1QuotaPaused("write", past);
    await store.clearExpiredD1QuotaPause();
    expect(await store.isD1QuotaBlocked("write")).toBe(false);
  });
});

describe("runnable queue depth", () => {
  it("excludes pending jobs with future run_after", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();

    await store.enqueueJob("poll_hacker_address", { address: "bc1qa" }, 1, now);
    await store.enqueueJob("poll_hacker_address", { address: "bc1qb" }, 1, future);

    expect(await store.getQueueDepth()).toBe(1);
    expect(await store.getPendingQueueDepthAll()).toBe(2);
  });
});
