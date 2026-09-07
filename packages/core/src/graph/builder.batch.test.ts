import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "@cointrace/db";
import { Store } from "@cointrace/db";
import {
  applyHackTraceEdgesChunk,
  computeHackTraceEdges,
  type HackTraceEdges,
} from "../graph/builder.js";
import type { ChainTxDetail } from "../chain/types.js";

function sampleTx(): ChainTxDetail {
  return {
    txid: "txchunk",
    fee: 100,
    status: { block_height: 800000, block_time: 1700000000 },
    vin: [
      {
        is_coinbase: false,
        prevout: { scriptpubkey_address: "bc1qvictim", value: 5000 },
      },
      {
        is_coinbase: false,
        prevout: { scriptpubkey_address: "bc1qhacker", value: 1000 },
      },
    ],
    vout: [
      { scriptpubkey_address: "bc1qhacker", value: 4000 },
      { scriptpubkey_address: "bc1qdown1", value: 1500 },
      { scriptpubkey_address: "bc1qdown2", value: 500 },
    ],
  };
}

describe("applyHackTraceEdgesChunk", () => {
  it("applies edge slices and resumes by index", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db, { d1BatchSize: 8 });

    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
    });

    const hackers = new Set(["bc1qhacker"]);
    const computed: HackTraceEdges = computeHackTraceEdges(sampleTx(), hackers, {
      spendingAddress: "bc1qhacker",
      spendingHop: 0,
    });

    const first = await applyHackTraceEdgesChunk(
      store,
      { txid: "txchunk", blockTime: "2024-01-01T00:00:00.000Z" },
      computed,
      { startEdgeIndex: 0, maxEdges: 1 },
    );
    expect(first.complete).toBe(false);
    expect(first.edgesApplied).toBe(1);

    const second = await applyHackTraceEdgesChunk(
      store,
      { txid: "txchunk", blockTime: "2024-01-01T00:00:00.000Z" },
      computed,
      { startEdgeIndex: first.nextEdgeIndex, maxEdges: 10 },
    );
    expect(second.complete).toBe(true);

    const edgeCount = sqlite.prepare(`SELECT count(*) as c FROM edges WHERE txid = 'txchunk'`).get() as {
      c: number;
    };
    expect(edgeCount.c).toBeGreaterThan(0);
  });

  it("resumes from cached flat edges without recomputing on continuation", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db, { d1BatchSize: 8 });

    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
    });

    const hackers = new Set(["bc1qhacker"]);
    const computed: HackTraceEdges = computeHackTraceEdges(sampleTx(), hackers, {
      spendingAddress: "bc1qhacker",
      spendingHop: 0,
    });
    const flat = [...computed.inToHacker, ...computed.outFromHacker];

    const first = await applyHackTraceEdgesChunk(
      store,
      { txid: "txchunk", blockTime: "2024-01-01T00:00:00.000Z" },
      { flat, victimAddresses: computed.victimAddresses },
      { startEdgeIndex: 0, maxEdges: 1 },
    );
    expect(first.complete).toBe(false);

    const second = await applyHackTraceEdgesChunk(
      store,
      { txid: "txchunk", blockTime: "2024-01-01T00:00:00.000Z" },
      { flat, victimAddresses: [] },
      { startEdgeIndex: first.nextEdgeIndex, maxEdges: 10 },
    );
    expect(second.complete).toBe(true);
  });

  it("keeps victim_dust edge but does not upsert victim as downstream", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);

    await store.upsertAddress({ address: "bc1qvictim", role: "victim", source: "derived" });
    await store.upsertAddress({
      address: "bc1qhacker",
      role: "hacker",
      isFlaggedHacker: true,
    });
    await store.upsertAddress({
      address: "bc1qdown1",
      role: "downstream",
      hopFromHacker: 1,
    });
    await store.upsertEdge({
      fromAddress: "bc1qvictim",
      toAddress: "bc1qhacker",
      txid: "tx_in",
      amountSats: 5_000_000,
      direction: "in_to_hacker",
    });

    const dustTx: ChainTxDetail = {
      txid: "tx_dust",
      fee: 100,
      status: { block_height: 800001, block_time: 1700000100 },
      vin: [{ is_coinbase: false, prevout: { scriptpubkey_address: "bc1qdown1", value: 5000 } }],
      vout: [
        { scriptpubkey_address: "bc1qvictim", value: 1000 },
        { scriptpubkey_address: "bc1qchange", value: 3900 },
      ],
    };

    const hackers = new Set(["bc1qhacker"]);
    const computed = computeHackTraceEdges(dustTx, hackers, {
      spendingAddress: "bc1qdown1",
      spendingHop: 1,
    });

    await applyHackTraceEdgesChunk(
      store,
      { txid: "tx_dust", blockTime: "2024-01-02T00:00:00.000Z" },
      computed,
      { flaggedHackers: hackers },
    );

    const victimRow = await store.getAddress("bc1qvictim");
    expect(victimRow?.role).toBe("victim");

    const dustEdge = sqlite
      .prepare(
        `SELECT edge_kind FROM edges WHERE txid = 'tx_dust' AND to_address = 'bc1qvictim'`,
      )
      .get() as { edge_kind: string | null };
    expect(dustEdge.edge_kind).toBe("victim_dust");

    const edgeCount = sqlite
      .prepare(`SELECT count(*) as c FROM edges WHERE txid = 'tx_dust'`)
      .get() as { c: number };
    expect(edgeCount.c).toBeGreaterThan(0);
  });
});
