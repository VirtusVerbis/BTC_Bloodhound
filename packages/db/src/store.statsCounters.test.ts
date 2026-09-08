import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("scheduler stats counters", () => {
  async function openStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return { sqlite, store: new Store(db) };
  }

  it("increments victim_count on victim upsert", async () => {
    const { store } = await openStore();
    await store.upsertAddress({ address: "bc1qvictim", role: "victim" });
    const stats = await store.computeStatsCounts();
    expect(stats.victimCount).toBe(1);
  });

  it("updates edge total counters on upsertEdgesBatch", async () => {
    const { store } = await openStore();
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qa",
        toAddress: "bc1qb",
        txid: "tx1",
        amountSats: 1000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "bc1qb",
        toAddress: "bc1qc",
        txid: "tx2",
        amountSats: 500,
        direction: "out_from_hacker",
      },
    ]);
    const stats = await store.computeStatsCounts();
    expect(stats.totalInSats).toBe(1000);
    expect(stats.totalOutSats).toBe(500);
  });

  it("reconcileStatsCounters repairs drift", async () => {
    const { sqlite, store } = await openStore();
    await store.upsertAddress({ address: "bc1qvictim", role: "victim" });
    sqlite.prepare("UPDATE scheduler_state SET victim_count = 0 WHERE id = 1").run();
    await store.reconcileStatsCounters();
    expect((await store.computeStatsCounts()).victimCount).toBe(1);
  });

  it("countDownstreamTreeNodes uses cached count for matching maxDepth", async () => {
    const { store } = await openStore();
    await store.upsertAddress({
      address: "bc1qdown",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.reconcileDownstreamTreeCount(5);
    expect(await store.countDownstreamTreeNodes(5)).toBe(1);
  });
});
