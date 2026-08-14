import { describe, expect, it } from "vitest";
import { aggregateFanoutOutputs, buildFanoutMeta } from "./spendFanout.js";

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
});
