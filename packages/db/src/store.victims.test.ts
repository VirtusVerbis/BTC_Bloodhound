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
});
