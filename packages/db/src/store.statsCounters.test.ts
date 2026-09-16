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

  it("reconcileCheapCounters does not rescan victim_count", async () => {
    const { sqlite, store } = await openStore();
    await store.upsertAddress({ address: "bc1qvictim", role: "victim" });
    sqlite.prepare("UPDATE scheduler_state SET victim_count = 0 WHERE id = 1").run();
    await store.reconcileCheapCounters();
    expect((await store.computeStatsCounts()).victimCount).toBe(0);
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

  it("ensureDownstreamTreeDepth reconciles when depth mismatches", async () => {
    const { sqlite, store } = await openStore();
    await store.upsertAddress({
      address: "bc1qdown",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    sqlite.prepare("UPDATE scheduler_state SET downstream_tree_max_depth = 10 WHERE id = 1").run();
    await store.ensureDownstreamTreeDepth(5);
    const state = await store.getSchedulerState();
    expect(state?.downstreamTreeMaxDepth).toBe(5);
    expect(state?.downstreamTreeCount).toBe(1);
  });

  it("computeStatsCountsByHack groups hackers and victim edges by hack_id", async () => {
    const { store } = await openStore();
    await store.upsertAddress({
      address: "bc1qcoldhacker",
      role: "hacker",
      isFlaggedHacker: true,
      hackId: "coldcard",
      totalReceivedSats: 1000,
    });
    await store.upsertAddress({
      address: "bc1qliquidhacker",
      role: "hacker",
      isFlaggedHacker: true,
      hackId: "liquid",
      source: "x",
      totalReceivedSats: 2000,
    });
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qvictim1",
        toAddress: "bc1qcoldhacker",
        txid: "tx-cold",
        amountSats: 1000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "bc1qvictim2",
        toAddress: "bc1qliquidhacker",
        txid: "tx-liquid",
        amountSats: 2000,
        direction: "in_to_hacker",
      },
    ]);

    const byHack = await store.computeStatsCountsByHack();
    const coldcard = byHack.find((h) => h.id === "coldcard");
    const liquid = byHack.find((h) => h.id === "liquid");
    expect(coldcard).toEqual({ id: "coldcard", hackerCount: 1, victimCount: 1, totalInSats: 1000 });
    expect(liquid).toEqual({ id: "liquid", hackerCount: 1, victimCount: 1, totalInSats: 2000 });
  });

  it("maybeRefreshHackStatsDaily runs the join once per UTC day", async () => {
    const { store } = await openStore();
    await store.upsertAddress({
      address: "bc1qcoldhacker",
      role: "hacker",
      isFlaggedHacker: true,
      hackId: "coldcard",
      totalReceivedSats: 1000,
    });
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qvictim1",
        toAddress: "bc1qcoldhacker",
        txid: "tx-cold",
        amountSats: 1000,
        direction: "in_to_hacker",
      },
    ]);

    const day = new Date("2026-09-16T00:01:00.000Z");
    expect(await store.maybeRefreshHackStatsDaily(day)).toBe(true);
    expect(await store.maybeRefreshHackStatsDaily(day)).toBe(false);

    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qvictim2",
        toAddress: "bc1qcoldhacker",
        txid: "tx-cold-2",
        amountSats: 500,
        direction: "in_to_hacker",
      },
    ]);
    expect(await store.maybeRefreshHackStatsDaily(new Date("2026-09-16T12:00:00.000Z"))).toBe(false);

    const sameDay = await store.getStats();
    expect(sameDay.hacks.find((h) => h.id === "coldcard")).toMatchObject({
      victimCount: 1,
      totalInSats: 1000,
      label: "Coldcard",
    });

    expect(await store.maybeRefreshHackStatsDaily(new Date("2026-09-17T00:01:00.000Z"))).toBe(true);
    const nextDay = await store.getStats();
    expect(nextDay.hacks.find((h) => h.id === "coldcard")).toMatchObject({
      victimCount: 2,
      totalInSats: 1500,
    });
  });

  it("getStats returns labeled zeros when daily hack stats are missing", async () => {
    const { store } = await openStore();
    const stats = await store.getStats();
    expect(stats.hacks).toEqual([
      { id: "coldcard", victimCount: 0, hackerCount: 0, totalInSats: 0, label: "Coldcard" },
      { id: "liquid", victimCount: 0, hackerCount: 0, totalInSats: 0, label: "Liquid" },
    ]);
  });

  it("reconcileStatsCounters leaves incremental edge totals unchanged", async () => {
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
    await store.reconcileStatsCounters();
    const stats = await store.computeStatsCounts();
    expect(stats.totalInSats).toBe(1000);
    expect(stats.totalOutSats).toBe(500);
  });
});
