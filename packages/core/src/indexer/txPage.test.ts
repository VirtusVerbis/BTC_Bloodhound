import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import {
  classifyPageTx,
  pageEntryToChainTxDetail,
  shouldSkipGetTx,
  txInvolvesSpendFromPage,
  isSpendFanout,
} from "./txPage.js";

const ADDRESS = "bc1qpeeladdrxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const OTHER = "bc1qotheraddrxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

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
});
