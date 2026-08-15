import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("Store batch reads", () => {
  let store: Store;

  beforeEach(() => {
    const opened = openDatabase(":memory:");
    runMigrations(opened.sqlite);
    store = new Store(opened.db);
  });

  it("getAddressesMap returns rows keyed by address", async () => {
    await store.upsertAddressesBatch([
      { address: "bc1qa", role: "hacker", source: "admin", isFlaggedHacker: true },
      { address: "bc1qb", role: "downstream", source: "derived" },
    ]);
    const map = await store.getAddressesMap(["bc1qa", "bc1qb", "bc1qmissing"]);
    expect(map.size).toBe(2);
    expect(map.get("bc1qa")?.role).toBe("hacker");
    expect(map.get("bc1qb")?.role).toBe("downstream");
    expect(map.has("bc1qmissing")).toBe(false);
  });

  it("getAddressesMap batches large address lists", async () => {
    const seeded = Array.from({ length: 5 }, (_, i) => ({
      address: `bc1qseed${String(i).padStart(3, "0")}`,
      role: "downstream" as const,
      source: "derived" as const,
    }));
    await store.upsertAddressesBatch(seeded);
    const dummy = Array.from({ length: 101 }, (_, i) => `bc1qdummy${String(i).padStart(4, "0")}`);
    const map = await store.getAddressesMap([...dummy, "bc1qseed002"]);
    expect(map.size).toBe(1);
    expect(map.get("bc1qseed002")?.address).toBe("bc1qseed002");
  });

  it("getEdgesFromAddressesMap groups edges by from_address", async () => {
    await store.upsertAddressesBatch([
      { address: "bc1qh1", role: "hacker", source: "admin", isFlaggedHacker: true },
      { address: "bc1qd1", role: "downstream", source: "derived" },
      { address: "bc1qd2", role: "downstream", source: "derived" },
    ]);
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd1",
        txid: "tx1",
        amountSats: 1000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd2",
        txid: "tx2",
        amountSats: 2000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qd1",
        toAddress: "bc1qd2",
        txid: "tx3",
        amountSats: 500,
        direction: "out_from_hacker",
      },
    ]);
    const map = await store.getEdgesFromAddressesMap(["bc1qh1", "bc1qd1", "bc1qnone"]);
    expect(map.get("bc1qh1")).toHaveLength(2);
    expect(map.get("bc1qd1")).toHaveLength(1);
    expect(map.get("bc1qnone")).toEqual([]);
  });

  it("getTransactionsByTxids batches large txid lists", async () => {
    const txids = Array.from({ length: 101 }, (_, i) => `tx${String(i).padStart(4, "0")}`);
    for (const txid of txids) {
      await store.upsertTransaction({
        txid,
        blockHeight: 1,
        blockTime: "2026-01-01T00:00:00.000Z",
        feeSats: 0,
      });
    }
    const map = await store.getTransactionsByTxids(txids);
    expect(map.size).toBe(101);
    expect(map.get("tx0000")?.txid).toBe("tx0000");
    expect(map.get("tx0100")?.txid).toBe("tx0100");
  });

  it("getOutEdgesFromAddress filters, sorts, and limits", async () => {
    await store.upsertAddressesBatch([
      { address: "bc1qh1", role: "hacker", source: "admin", isFlaggedHacker: true },
      { address: "bc1qd1", role: "downstream", source: "derived" },
      { address: "bc1qd2", role: "downstream", source: "derived" },
      { address: "bc1qd3", role: "downstream", source: "derived" },
    ]);
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd1",
        txid: "tx1",
        amountSats: 500,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd2",
        txid: "tx2",
        amountSats: 2000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd3",
        txid: "tx3",
        amountSats: 100,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd1",
        txid: "tx4",
        amountSats: 3000,
        direction: "in_to_hacker",
      },
    ]);
    const rows = await store.getOutEdgesFromAddress("bc1qh1", { minEdgeSats: 1000, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toAddress).toBe("bc1qd2");
    expect(rows[0]?.amountSats).toBe(2000);
  });

  it("countOutEdgesFromAddress and keyset pagination", async () => {
    await store.upsertAddressesBatch([
      { address: "bc1qh1", role: "hacker", source: "admin", isFlaggedHacker: true },
      { address: "bc1qd1", role: "downstream", source: "derived" },
      { address: "bc1qd2", role: "downstream", source: "derived" },
      { address: "bc1qd3", role: "downstream", source: "derived" },
    ]);
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd1",
        txid: "tx1",
        amountSats: 3000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd2",
        txid: "tx2",
        amountSats: 2000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qh1",
        toAddress: "bc1qd3",
        txid: "tx3",
        amountSats: 1000,
        direction: "out_from_hacker",
      },
    ]);
    expect(await store.countOutEdgesFromAddress("bc1qh1", { minEdgeSats: 1500 })).toBe(2);

    const page1 = await store.getOutEdgesFromAddress("bc1qh1", { minEdgeSats: 0, limit: 2 });
    expect(page1.map((e) => e.toAddress)).toEqual(["bc1qd1", "bc1qd2"]);

    const page2 = await store.getOutEdgesFromAddress("bc1qh1", {
      minEdgeSats: 0,
      limit: 2,
      after: { amountSats: page1[1]!.amountSats, toAddress: page1[1]!.toAddress },
    });
    expect(page2.map((e) => e.toAddress)).toEqual(["bc1qd3"]);
  });

  it("getOutEdgesFromParents paginates across parents", async () => {
    await store.upsertAddressesBatch([
      { address: "bc1qp1", role: "downstream", source: "derived" },
      { address: "bc1qp2", role: "downstream", source: "derived" },
      { address: "bc1qc1", role: "downstream", source: "derived" },
      { address: "bc1qc2", role: "downstream", source: "derived" },
    ]);
    await store.upsertEdgesBatch([
      {
        fromAddress: "bc1qp1",
        toAddress: "bc1qc1",
        txid: "tx1",
        amountSats: 1000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "bc1qp2",
        toAddress: "bc1qc2",
        txid: "tx2",
        amountSats: 900,
        direction: "out_from_hacker",
      },
    ]);
    const first = await store.getOutEdgesFromParents(["bc1qp1", "bc1qp2"], { limit: 1 });
    expect(first.edges).toHaveLength(1);
    expect(first.edges[0]?.toAddress).toBe("bc1qc1");
    expect(first.nextAfter).not.toBeNull();

    const second = await store.getOutEdgesFromParents(["bc1qp1", "bc1qp2"], {
      limit: 2,
      after: first.nextAfter!,
    });
    expect(second.edges).toHaveLength(1);
    expect(second.edges[0]?.toAddress).toBe("bc1qc2");
    expect(second.nextAfter).toBeNull();
  });
});
