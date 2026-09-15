import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("victim address helpers", () => {
  it("getVictimAddressSetForHacker returns distinct in_to_hacker sources", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertEdgesBatch([
      {
        fromAddress: "victim_a",
        toAddress: "hack1",
        txid: "tx1",
        amountSats: 1000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "victim_b",
        toAddress: "hack1",
        txid: "tx2",
        amountSats: 2000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "victim_a",
        toAddress: "hack1",
        txid: "tx3",
        amountSats: 500,
        direction: "in_to_hacker",
      },
    ]);

    const victims = await store.getVictimAddressSetForHacker("hack1");
    expect(victims).toEqual(new Set(["victim_a", "victim_b"]));
  });

  it("getVictimAddressSetForHacker and listVictimsForHacker omit sub-floor edges when minEdgeSats is set", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertEdgesBatch([
      {
        fromAddress: "victim_dust",
        toAddress: "hack1",
        txid: "tx_dust",
        amountSats: 1000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "victim_mid",
        toAddress: "hack1",
        txid: "tx_mid",
        amountSats: 2000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "victim_large",
        toAddress: "hack1",
        txid: "tx_large",
        amountSats: 200_000,
        direction: "in_to_hacker",
      },
    ]);

    expect(await store.getVictimAddressSetForHacker("hack1")).toEqual(
      new Set(["victim_dust", "victim_mid", "victim_large"]),
    );
    expect(await store.getVictimAddressSetForHacker("hack1", 1000, 100_000)).toEqual(
      new Set(["victim_large"]),
    );
    expect([...(await store.getVictimAddressSetForHacker("hack1", 1))]).toEqual(["victim_large"]);
    expect([...(await store.getVictimAddressSetForHacker("hack1", 2))]).toEqual([
      "victim_large",
      "victim_mid",
    ]);

    const listed = await store.listVictimsForHacker("hack1", 100, 100_000);
    expect(listed.map((row) => row.address)).toEqual(["victim_large"]);
  });

  it("filterVictimsAmong returns addresses linked to flagged hackers", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertEdge({
      fromAddress: "victim_x",
      toAddress: "hack1",
      txid: "tx1",
      amountSats: 1000,
      direction: "in_to_hacker",
    });

    const victims = await store.filterVictimsAmong(
      ["victim_x", "random_down"],
      new Set(["hack1"]),
    );
    expect(victims).toEqual(new Set(["victim_x"]));
    expect(await store.filterKnownVictimAddresses(["victim_x", "random_down"])).toEqual(
      new Set(["victim_x"]),
    );
  });

  it("listHackersForVictim batches address lookups", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      label: "Hacker One",
    });
    await store.upsertAddress({
      address: "hack2",
      role: "hacker",
      isFlaggedHacker: true,
      label: "Hacker Two",
    });
    await store.upsertEdgesBatch([
      {
        fromAddress: "victim_x",
        toAddress: "hack1",
        txid: "tx1",
        amountSats: 1000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "victim_x",
        toAddress: "hack2",
        txid: "tx2",
        amountSats: 2000,
        direction: "in_to_hacker",
      },
    ]);

    const getAddress = vi.spyOn(store, "getAddress");
    const getAddressesMap = vi.spyOn(store, "getAddressesMap");

    const hackers = await store.listHackersForVictim("victim_x");
    expect(hackers).toHaveLength(2);
    expect(hackers.map((h) => h.label).sort()).toEqual(["Hacker One", "Hacker Two"]);
    expect(getAddressesMap).toHaveBeenCalled();
    expect(getAddress).not.toHaveBeenCalled();
  });

  it("listVictimRefundsForHacker returns large returns regardless of edge_kind and caps rows", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertEdgesBatch([
      {
        fromAddress: "victim_a",
        toAddress: "hack1",
        txid: "tx_theft",
        amountSats: 4_000_000_000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "down1",
        toAddress: "victim_a",
        txid: "tx_refund",
        amountSats: 3_400_000_000,
        direction: "out_from_hacker",
        edgeKind: "victim_dust",
      },
      {
        fromAddress: "down1",
        toAddress: "victim_a",
        txid: "tx_dust",
        amountSats: 546,
        direction: "out_from_hacker",
        edgeKind: "victim_dust",
      },
      {
        fromAddress: "down1",
        toAddress: "unrelated",
        txid: "tx_other",
        amountSats: 5_000_000,
        direction: "out_from_hacker",
      },
    ]);

    const refunds = await store.listVictimRefundsForHacker("hack1", { minEdgeSats: 100_000 });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.txid).toBe("tx_refund");
    expect(refunds[0]!.amountSats).toBe(3_400_000_000);

    const viaSet = await store.listVictimRefundsForHacker("hack1", {
      minEdgeSats: 100_000,
      victimAddresses: ["victim_a"],
    });
    expect(viaSet.map((r) => r.txid)).toEqual(["tx_refund"]);

    const capped = await store.listVictimRefundsForHacker("hack1", { minEdgeSats: 100_000, limit: 0 });
    expect(capped).toEqual([]);
  });

  it("listVictimRefundsForHacker hard-caps at 32 rows", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertEdge({
      fromAddress: "victim_a",
      toAddress: "hack1",
      txid: "tx_theft",
      amountSats: 10_000_000,
      direction: "in_to_hacker",
    });
    await store.upsertEdgesBatch(
      Array.from({ length: 40 }, (_, i) => ({
        fromAddress: "down1",
        toAddress: "victim_a",
        txid: `tx_refund_${i}`,
        amountSats: 200_000 + i,
        direction: "out_from_hacker" as const,
      })),
    );

    const refunds = await store.listVictimRefundsForHacker("hack1", { minEdgeSats: 100_000, limit: 100 });
    expect(refunds).toHaveLength(32);
    expect(refunds[0]!.amountSats).toBe(200_000 + 39);
    expect(refunds.every((row) => row.fanoutMetaJson == null)).toBe(true);
  });

  it("listVictimRefundsForHacker merges per-address top rows into a global cap", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertEdgesBatch([
      {
        fromAddress: "victim_a",
        toAddress: "hack1",
        txid: "tx_in_a",
        amountSats: 1_000_000,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "victim_b",
        toAddress: "hack1",
        txid: "tx_in_b",
        amountSats: 1_000_000,
        direction: "in_to_hacker",
      },
    ]);
    await store.upsertEdgesBatch([
      ...Array.from({ length: 20 }, (_, i) => ({
        fromAddress: "down1",
        toAddress: "victim_a",
        txid: `tx_a_${i}`,
        amountSats: 100_000 + i,
        direction: "out_from_hacker" as const,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        fromAddress: "down1",
        toAddress: "victim_b",
        txid: `tx_b_${i}`,
        amountSats: 200_000 + i,
        direction: "out_from_hacker" as const,
      })),
    ]);

    const refunds = await store.listVictimRefundsForHacker("hack1", {
      minEdgeSats: 100_000,
      victimAddresses: ["victim_a", "victim_b"],
    });
    expect(refunds).toHaveLength(32);
    expect(refunds.filter((row) => row.toAddress === "victim_b")).toHaveLength(20);
    expect(refunds.filter((row) => row.toAddress === "victim_a")).toHaveLength(12);
    expect(Math.min(...refunds.map((row) => row.amountSats))).toBe(100_008);
  });

  it("listVictimRefundsForHacker probe-caps victimAddresses to the first 32", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    const victims = Array.from({ length: 33 }, (_, i) => `victim_${String(i).padStart(2, "0")}`);
    await store.upsertEdgesBatch(
      victims.map((address, i) => ({
        fromAddress: address,
        toAddress: "hack1",
        txid: `tx_in_${i}`,
        amountSats: 100_000,
        direction: "in_to_hacker" as const,
      })),
    );
    await store.upsertEdgesBatch([
      {
        fromAddress: "down1",
        toAddress: victims[0]!,
        txid: "tx_refund_first",
        amountSats: 1_000_000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "down1",
        toAddress: victims[32]!,
        txid: "tx_refund_last",
        amountSats: 9_000_000,
        direction: "out_from_hacker",
      },
    ]);

    const refunds = await store.listVictimRefundsForHacker("hack1", {
      minEdgeSats: 100_000,
      victimAddresses: victims,
    });
    expect(refunds.map((row) => row.txid)).toEqual(["tx_refund_first"]);
  });

  it("listVictimRefundsForHacker subquery ignores dust-only victims", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertEdgesBatch([
      {
        fromAddress: "victim_dust",
        toAddress: "hack1",
        txid: "tx_dust_in",
        amountSats: 500,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "down1",
        toAddress: "victim_dust",
        txid: "tx_to_dust",
        amountSats: 5_000_000,
        direction: "out_from_hacker",
      },
    ]);

    const refunds = await store.listVictimRefundsForHacker("hack1", { minEdgeSats: 100_000 });
    expect(refunds).toEqual([]);
  });
});
