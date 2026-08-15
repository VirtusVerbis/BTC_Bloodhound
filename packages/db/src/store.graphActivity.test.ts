import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("graph activity", () => {
  let store: Store;
  let sqlite: ReturnType<typeof openDatabase>["sqlite"];

  beforeEach(() => {
    const opened = openDatabase(":memory:");
    sqlite = opened.sqlite;
    runMigrations(sqlite);
    store = new Store(opened.db);
  });

  it("getExistingAddressSet returns only known addresses", async () => {
    await store.upsertAddressesBatch([
      { address: "bc1qknown", role: "victim", source: "derived" },
    ]);
    const set = await store.getExistingAddressSet(["bc1qknown", "bc1qnew"]);
    expect(set.has("bc1qknown")).toBe(true);
    expect(set.has("bc1qnew")).toBe(false);
  });

  it("bumpHackerGraphActivity keeps the latest timestamp", async () => {
    await store.upsertAddressesBatch([
      {
        address: "bc1qhacker",
        role: "hacker",
        source: "admin",
        isFlaggedHacker: true,
      },
    ]);
    await store.bumpHackerGraphActivity(["bc1qhacker"], "2024-01-01T00:00:00.000Z");
    await store.bumpHackerGraphActivity(["bc1qhacker"], "2024-06-01T00:00:00.000Z");
    await store.bumpHackerGraphActivity(["bc1qhacker"], "2024-03-01T00:00:00.000Z");
    const row = await store.getAddress("bc1qhacker");
    expect(row?.lastGraphActivityAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("findRootHackersForSpender walks multi-hop downstream to hacker", async () => {
    await store.upsertAddressesBatch([
      { address: "bc1qhacker", role: "hacker", source: "admin", isFlaggedHacker: true },
      { address: "bc1qdown1", role: "downstream", source: "derived", hopFromHacker: 1 },
      { address: "bc1qdown2", role: "downstream", source: "derived", hopFromHacker: 2 },
    ]);
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qhacker",
        toAddress: "bc1qdown1",
        txid: "tx1",
        amountSats: 1000,
        direction: "out_from_hacker",
        hopFromHacker: 1,
      },
      {
        fromAddress: "bc1qdown1",
        toAddress: "bc1qdown2",
        txid: "tx2",
        amountSats: 500,
        direction: "out_from_hacker",
        hopFromHacker: 2,
      },
    ]);
    const roots = await store.findRootHackersForSpender("bc1qdown2");
    expect(roots).toEqual(["bc1qhacker"]);
  });

  it("getHackerActivitySummary counts recent victims and downstream", async () => {
    const recent = "2025-01-02T00:00:00.000Z";
    const old = "2024-01-01T00:00:00.000Z";
    await store.upsertAddressesBatch([
      {
        address: "bc1qhacker",
        role: "hacker",
        source: "admin",
        isFlaggedHacker: true,
        totalReceivedSats: 1000,
      },
      {
        address: "bc1qvictim1",
        role: "victim",
        source: "derived",
      },
      {
        address: "bc1qvictim2",
        role: "victim",
        source: "derived",
      },
      {
        address: "bc1qdown1",
        role: "downstream",
        source: "derived",
        hopFromHacker: 1,
      },
    ]);
    sqlite.prepare("UPDATE addresses SET first_seen_at = ? WHERE address = ?").run(recent, "bc1qvictim1");
    sqlite.prepare("UPDATE addresses SET first_seen_at = ? WHERE address = ?").run(old, "bc1qvictim2");
    sqlite.prepare("UPDATE addresses SET first_seen_at = ? WHERE address = ?").run(recent, "bc1qdown1");
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qvictim1",
        toAddress: "bc1qhacker",
        txid: "txv1",
        amountSats: 500,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "bc1qvictim2",
        toAddress: "bc1qhacker",
        txid: "txv2",
        amountSats: 500,
        direction: "in_to_hacker",
      },
      {
        fromAddress: "bc1qhacker",
        toAddress: "bc1qdown1",
        txid: "txd1",
        amountSats: 200,
        direction: "out_from_hacker",
        hopFromHacker: 1,
      },
    ]);
    const summary = await store.getHackerActivitySummary(
      ["bc1qhacker"],
      "2025-01-01T00:00:00.000Z",
    );
    expect(summary.get("bc1qhacker")).toEqual({
      recentVictimCount: 1,
      recentDownstreamCount: 1,
    });
  });

  it("getHackerActivitySummary batches large hacker lists", async () => {
    const recent = "2025-01-02T00:00:00.000Z";
    await store.upsertAddressesBatch([
      {
        address: "bc1qhacker",
        role: "hacker",
        source: "admin",
        isFlaggedHacker: true,
        totalReceivedSats: 1000,
      },
      { address: "bc1qvictim1", role: "victim", source: "derived" },
    ]);
    sqlite.prepare("UPDATE addresses SET first_seen_at = ? WHERE address = ?").run(recent, "bc1qvictim1");
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qvictim1",
        toAddress: "bc1qhacker",
        txid: "txv1",
        amountSats: 500,
        direction: "in_to_hacker",
      },
    ]);

    const dummyHackers = Array.from({ length: 101 }, (_, i) => `bc1qdummy${String(i).padStart(4, "0")}`);
    const summary = await store.getHackerActivitySummary(
      [...dummyHackers, "bc1qhacker"],
      "2025-01-01T00:00:00.000Z",
    );
    expect(summary.get("bc1qhacker")).toEqual({
      recentVictimCount: 1,
      recentDownstreamCount: 0,
    });
  });
});
