import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "./index.js";

describe("getCrawlEnqueueCandidates min expand", () => {
  it("includes the pending hacker and hop-1 above the floor, largest first", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      expandStatus: "pending",
    });
    await store.upsertAddress({
      address: "small",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "pending",
    });
    await store.upsertAddress({
      address: "mid",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "pending",
    });
    await store.upsertAddress({
      address: "big",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "pending",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "small",
      txid: "txs",
      amountSats: 50_000,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "mid",
      txid: "txm",
      amountSats: 150_000,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "big",
      txid: "txb",
      amountSats: 400_000,
      direction: "out_from_hacker",
    });

    const rows = await store.getCrawlEnqueueCandidates("hack1", 10, 5, 100_000);
    expect(rows.map((r) => r.address)).toEqual(["hack1", "big", "mid"]);
  });
});

describe("listDownstreamForPoll min expand", () => {
  it("skips pending and expanded below the floor", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "pending-small",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "pending",
    });
    await store.upsertAddress({
      address: "pending-big",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "pending",
    });
    await store.upsertAddress({
      address: "expanded-small",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertAddress({
      address: "expanded-big",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "pending-small",
      txid: "txs",
      amountSats: 50_000,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "pending-big",
      txid: "txb",
      amountSats: 150_000,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "expanded-small",
      txid: "txe",
      amountSats: 1_000,
      direction: "out_from_hacker",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "expanded-big",
      txid: "txeb",
      amountSats: 200_000,
      direction: "out_from_hacker",
    });

    const due = await store.listDownstreamForPoll(10, 5, 600, 100_000);
    expect(due.map((r) => r.address).sort()).toEqual(["expanded-big", "pending-big"]);
    expect(await store.countDownstreamPollDue(5, 600, 100_000)).toBe(2);
  });
});

describe("getDownstreamExpandContext", () => {
  it("returns stored inbound_sats after an out_from_hacker upsert", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({
      address: "bc1qdown",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "pending",
    });
    await store.upsertEdge({
      fromAddress: "hack1",
      toAddress: "bc1qdown",
      txid: "tx1",
      amountSats: 125_000,
      direction: "out_from_hacker",
    });

    const ctx = await store.getDownstreamExpandContext(["bc1qdown"]);
    expect(ctx.get("bc1qdown")).toEqual({ expandStatus: "pending", inboundSats: 125_000 });
  });
});
