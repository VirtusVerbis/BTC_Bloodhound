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
});
