import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("listSpendTxidsOrderedForAddresses", () => {
  let store: Store;

  beforeEach(() => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    store = new Store(db);
  });

  it("respects limit with seeded edges", async () => {
    const spender = "bc1qspender";
    await store.upsertAddress({ address: spender, role: "downstream" });
    for (let i = 0; i < 10; i++) {
      const txid = `tx${i}`;
      await store.upsertTransaction({ txid, blockHeight: 1000 - i });
      await store.upsertEdge({
        fromAddress: spender,
        toAddress: `bc1qout${i}`,
        txid,
        amountSats: 1000,
        direction: "out_from_hacker",
        blockTime: `2025-01-0${i + 1}T00:00:00.000Z`,
      });
    }

    const txids = await store.listSpendTxidsOrderedForAddresses([spender], 3);
    expect(txids).toHaveLength(3);
    expect(txids[0]).toBe("tx0");
  });
});
