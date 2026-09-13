import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, Store } from "@cointrace/db";
import { aggregateFanoutOutputs, applySpendFanoutSummary, buildFanoutMeta } from "./spendFanout.js";

describe("spendFanout", () => {
  const config = { spendFanoutTopK: 3 };

  it("aggregates outputs excluding self and builds meta", () => {
    const spender = "bc1qspenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const tx = {
      txid: "fanouttx",
      vin: [{ prevout: { scriptpubkey_address: spender, value: 100000 } }],
      vout: [
        { scriptpubkey_address: "bc1qa", value: 50000 },
        { scriptpubkey_address: "bc1qb", value: 30000 },
        { scriptpubkey_address: spender, value: 10000 },
        { scriptpubkey_address: "bc1qc", value: 10000 },
      ],
    };
    const agg = aggregateFanoutOutputs(tx, spender);
    expect(agg.totalOutSats).toBe(90000);
    expect(agg.outputCount).toBe(4);
    const meta = buildFanoutMeta(tx, spender, config);
    expect(meta.topOutputs).toHaveLength(3);
    expect(meta.topOutputs[0]!.address).toBe("bc1qa");
  });

  it("marks a small fanout primary as skipped_min without storing the edge", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    const spender = "bc1qspenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const primary = "bc1qprimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const tx = {
      txid: "smallfan",
      vin: [{ prevout: { scriptpubkey_address: spender, value: 80_000 } }],
      vout: [
        { scriptpubkey_address: primary, value: 50_000 },
        { scriptpubkey_address: "bc1qotherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", value: 20_000 },
      ],
      status: { block_height: 800000, block_time: 1700000000 },
      fee: 100,
    };

    await applySpendFanoutSummary(store, tx, spender, 0, {
      spendFanoutTopK: 3,
      minExpandSats: 100_000,
    });

    expect((await store.getAddress(primary))?.expandStatus).toBe("skipped_min");
    expect((await store.getAddress(primary))?.inboundSats).toBe(70_000);
    const edge = sqlite
      .prepare(`SELECT amount_sats FROM edges WHERE txid = 'smallfan'`)
      .get() as { amount_sats: number } | undefined;
    expect(edge).toBeUndefined();
  });

  it("marks a large fanout primary as pending", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    const spender = "bc1qspenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const primary = "bc1qbigxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const tx = {
      txid: "bigfan",
      vin: [{ prevout: { scriptpubkey_address: spender, value: 200_000 } }],
      vout: [{ scriptpubkey_address: primary, value: 150_000 }],
      status: { block_height: 800000, block_time: 1700000000 },
      fee: 100,
    };

    await applySpendFanoutSummary(store, tx, spender, 0, {
      spendFanoutTopK: 3,
      minExpandSats: 100_000,
    });

    expect((await store.getAddress(primary))?.expandStatus).toBe("pending");
  });
});
