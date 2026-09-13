import { describe, expect, it } from "vitest";
import { pendingGapFillTxs, sliceNewerThanLastSeen, spendGapExceedsFloor } from "./pollGap.js";

describe("pollGap helpers", () => {
  it("slices txs newer than lastSeen and reports a miss", () => {
    const page = [{ txid: "new" }, { txid: "mid" }, { txid: "old" }];
    expect(sliceNewerThanLastSeen(page, "mid")).toEqual({
      newer: [{ txid: "new" }],
      lastSeenFound: true,
      lastSeenIndex: 1,
    });
    expect(sliceNewerThanLastSeen(page, "missing").lastSeenFound).toBe(false);
    expect(sliceNewerThanLastSeen(page, "missing").newer).toEqual(page);
    expect(sliceNewerThanLastSeen(page).lastSeenFound).toBe(true);
  });

  it("keeps spends and OP_RETURN for gap fill", () => {
    const address = "bc1qspend";
    const pending = pendingGapFillTxs(
      [
        {
          txid: "recv",
          vin: [{ prevout: { scriptpubkey_address: "bc1qother", value: 1000 } }],
          vout: [{ scriptpubkey_address: address, value: 1000 }],
        },
        {
          txid: "spend",
          vin: [{ prevout: { scriptpubkey_address: address, value: 200_000 } }],
          vout: [{ scriptpubkey_address: "bc1qdest", value: 199_000 }],
        },
        {
          txid: "note",
          vin: [{ prevout: { scriptpubkey_address: "bc1qother", value: 1000 } }],
          vout: [{ scriptpubkey_type: "op_return", scriptpubkey_asm: "OP_RETURN 41", value: 0 }],
        },
      ],
      address,
    );
    expect(pending.map((p) => p.txid)).toEqual(["spend", "note"]);
  });

  it("compares spent vs indexed against the expand floor", () => {
    expect(spendGapExceedsFloor(200_000, 100_000, 100_000)).toBe(true);
    expect(spendGapExceedsFloor(150_000, 100_000, 100_000)).toBe(false);
    expect(spendGapExceedsFloor(100_000, 100_000, 100_000)).toBe(false);
  });
});
