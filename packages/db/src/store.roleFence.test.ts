import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("address role fence", () => {
  async function freshStore() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    return new Store(db);
  }

  it("does not clobber downstream or hacker when upserting victim", async () => {
    const store = await freshStore();
    await store.upsertAddress({
      address: "bc1qdown",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });

    await store.upsertAddress({ address: "bc1qdown", role: "victim", hopFromHacker: null });
    await store.upsertAddressesBatch([{ address: "bc1qhacker", role: "victim" }]);

    const down = await store.getAddress("bc1qdown");
    expect(down?.role).toBe("downstream");
    expect(down?.hopFromHacker).toBe(1);
    expect((await store.getAddress("bc1qhacker"))?.role).toBe("hacker");
  });

  it("forceRole can still convert downstream to victim", async () => {
    const store = await freshStore();
    await store.upsertAddress({
      address: "bc1qdown",
      role: "downstream",
      hopFromHacker: 1,
    });
    await store.upsertAddress({
      address: "bc1qdown",
      role: "victim",
      hopFromHacker: null,
      forceRole: true,
    });
    const row = await store.getAddress("bc1qdown");
    expect(row?.role).toBe("victim");
    expect(row?.hopFromHacker).toBeNull();
  });

  it("restores hop-labelled victims that have no in_to_hacker edge", async () => {
    const store = await freshStore();
    await store.upsertAddress({
      address: "bc1qhop",
      role: "victim",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "bc1qloop",
      role: "victim",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertEdge({
      fromAddress: "bc1qloop",
      toAddress: "bc1qhacker",
      txid: "tx_theft",
      amountSats: 1000,
      direction: "in_to_hacker",
    });

    const dry = await store.repairDownstreamRole({ dryRun: true });
    expect(dry.repaired).toEqual([]);
    expect(dry.scanned).toBe(1);

    const result = await store.repairDownstreamRole();
    expect(result.repaired).toEqual(["bc1qhop"]);
    const hop = await store.getAddress("bc1qhop");
    expect(hop?.role).toBe("downstream");
    expect(hop?.hopFromHacker).toBe(1);
    expect(hop?.expandStatus).toBe("expanded");
    expect((await store.getAddress("bc1qloop"))?.role).toBe("victim");
  });
});
