import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import {
  classifyPageTx,
  pageEntryToChainTxDetail,
  parsePendingTxs,
  serializePendingTxs,
  shouldSkipGetTx,
  shouldTraceHackerReceive,
  txInvolvesSpendFromPage,
  isSpendFanout,
} from "./txPage.js";

const ADDRESS = "bc1qpeeladdrxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const OTHER = "bc1qotheraddrxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const HACKER = "bc1qhackerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const VICTIM = "bc1qvictimxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("txPage", () => {
  const config = loadConfig({});

  it("classifies receive-only fat tx", () => {
    const tx = {
      txid: "abc",
      vout: Array.from({ length: 37 }, (_, i) => ({
        scriptpubkey_address: i === 12 ? ADDRESS : OTHER,
        value: 1000,
      })),
      vin: [{ prevout: { scriptpubkey_address: OTHER, value: 50000 } }],
    };
    const classified = classifyPageTx(tx, ADDRESS);
    expect(classified.isSpend).toBe(false);
    expect(classified.voutCount).toBe(37);
    expect(txInvolvesSpendFromPage(tx, ADDRESS)).toBe(false);
    expect(shouldSkipGetTx(classified, ADDRESS, config)).toBe(true);
    expect(
      shouldSkipGetTx(classified, HACKER, config, { hop: 0, traceHackerReceives: true }),
    ).toBe(true);
  });

  it("allows skinny receive at hop 0 when traceHackerReceives enabled", () => {
    const tx = {
      txid: "deposit1",
      vin: [{ prevout: { scriptpubkey_address: VICTIM, value: 50_000 } }],
      vout: [{ scriptpubkey_address: HACKER, value: 50_000 }],
    };
    const classified = classifyPageTx(tx, HACKER);
    expect(classified.isSpend).toBe(false);
    expect(shouldTraceHackerReceive(classified, config, { hop: 0 })).toBe(true);
    expect(
      shouldSkipGetTx(classified, HACKER, config, { hop: 0, traceHackerReceives: true, pageEntry: tx }),
    ).toBe(false);
  });

  it("skips receive at hop 1 even when traceHackerReceives enabled", () => {
    const classified = {
      txid: "deposit1",
      isSpend: false,
      voutCount: 1,
      outputAddressCount: 1,
    };
    expect(shouldTraceHackerReceive(classified, config, { hop: 1 })).toBe(false);
    expect(
      shouldSkipGetTx(classified, ADDRESS, config, { hop: 1, traceHackerReceives: true }),
    ).toBe(true);
  });

  it("skips sweep_relay receives", () => {
    const classified = {
      txid: "deposit1",
      isSpend: false,
      voutCount: 1,
      outputAddressCount: 1,
    };
    expect(
      shouldTraceHackerReceive(classified, config, {
        hop: 0,
        expandProfile: "sweep_relay",
      }),
    ).toBe(false);
    expect(
      shouldSkipGetTx(classified, ADDRESS, config, {
        hop: 0,
        expandProfile: "sweep_relay",
        traceHackerReceives: true,
      }),
    ).toBe(true);
  });

  it("classifies skinny sweep tx", () => {
    const tx = {
      txid: "sweep1",
      vin: [{ prevout: { scriptpubkey_address: ADDRESS, value: 50000 } }],
      vout: [
        { scriptpubkey_address: OTHER, value: 49000 },
        { scriptpubkey_address: OTHER, value: 500 },
      ],
    };
    const classified = classifyPageTx(tx, ADDRESS);
    expect(classified.isSpend).toBe(true);
    expect(shouldSkipGetTx(classified, ADDRESS, config)).toBe(false);
  });

  it("detects spend fanout from page entry", () => {
    const tx = {
      txid: "fanout1",
      vin: [{ prevout: { scriptpubkey_address: ADDRESS, value: 100000 } }],
      vout: Array.from({ length: 25 }, (_, i) => ({
        scriptpubkey_address: `bc1qout${i}`,
        value: 1000,
      })),
    };
    const classified = classifyPageTx(tx, ADDRESS);
    expect(isSpendFanout(classified, ADDRESS, config, tx)).toBe(true);
    expect(pageEntryToChainTxDetail(tx).vout.length).toBe(25);
  });

  it("serializes compact page snapshot for skinny receives", () => {
    const tx = {
      txid: "deposit1",
      status: { block_height: 100 },
      vin: [{ prevout: { scriptpubkey_address: VICTIM, value: 50_000 } }],
      vout: [{ scriptpubkey_address: HACKER, value: 50_000 }],
    };
    const pending = [{ ...classifyPageTx(tx, HACKER), pageEntry: tx }];
    const serialized = serializePendingTxs(pending, {
      traceHackerReceives: true,
      maxVoutCountSkipGetTx: 20,
    });
    expect(serialized[0]?.pageSnapshot?.vin).toHaveLength(1);
    const roundTrip = parsePendingTxs({ pendingTxs: serialized });
    expect(roundTrip[0]?.pageSnapshot?.vout[0]?.scriptpubkey_address).toBe(HACKER);
  });

  it("retains OP_RETURN asm fields in page snapshot round-trip", () => {
    const tx = {
      txid: "opret1",
      status: { block_height: 101 },
      vin: [{ prevout: { scriptpubkey_address: VICTIM, value: 50_000 } }],
      vout: [
        { scriptpubkey_address: HACKER, value: 49_000 },
        {
          scriptpubkey_type: "op_return",
          scriptpubkey_asm: "OP_RETURN 48656c6c6f",
          scriptpubkey: "6a0548656c6c6f",
          value: 0,
        },
      ],
    };
    const pending = [{ ...classifyPageTx(tx, HACKER), pageEntry: tx }];
    const serialized = serializePendingTxs(pending, {
      traceHackerReceives: true,
      maxVoutCountSkipGetTx: 20,
    });
    const snap = serialized[0]?.pageSnapshot;
    expect(snap?.vout[1]?.scriptpubkey_asm).toBe("OP_RETURN 48656c6c6f");
    expect(snap?.vout[1]?.scriptpubkey_type).toBe("op_return");
    const roundTrip = parsePendingTxs({ pendingTxs: serialized });
    const restored = pageEntryToChainTxDetail({
      txid: "opret1",
      ...roundTrip[0]!.pageSnapshot!,
    });
    expect(restored.vout[1]?.scriptpubkey_asm).toBe("OP_RETURN 48656c6c6f");
  });
});
