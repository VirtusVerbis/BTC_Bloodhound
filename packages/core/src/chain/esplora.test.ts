import { describe, expect, it, vi } from "vitest";
import { getAddressTxsAll } from "./esplora.js";
import type { ChainProvider, ChainTxSummary } from "./types.js";

function makeTx(id: string): ChainTxSummary {
  return { txid: id, status: { block_height: 1, block_time: 1 } };
}

describe("getAddressTxsAll", () => {
  it("paginates until an empty chain page", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => makeTx(`tx${i}`));
    const page2 = [makeTx("tx25"), makeTx("tx26")];

    const provider: ChainProvider = {
      name: "mock",
      getAddressTxs: vi.fn().mockResolvedValue(page1),
      getAddressTxsChainPage: vi.fn().mockResolvedValueOnce(page2).mockResolvedValueOnce([]),
      getTx: vi.fn(),
      getAddressStats: vi.fn(),
    };

    const all = await getAddressTxsAll(provider, "addr1");
    expect(all).toHaveLength(27);
    expect(provider.getAddressTxsChainPage).toHaveBeenCalledWith("addr1", "tx24");
  });
});
