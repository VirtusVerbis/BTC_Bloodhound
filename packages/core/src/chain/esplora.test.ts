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

  it("handles mempool-style first page of 50 plus chain pages of 25", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => makeTx(`tx${i}`));
    const page2 = Array.from({ length: 25 }, (_, i) => makeTx(`tx${50 + i}`));
    const page3 = Array.from({ length: 5 }, (_, i) => makeTx(`tx${75 + i}`));

    const provider: ChainProvider = {
      name: "mock",
      getAddressTxs: vi.fn().mockResolvedValue(page1),
      getAddressTxsChainPage: vi
        .fn()
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page3)
        .mockResolvedValueOnce([]),
      getTx: vi.fn(),
      getAddressStats: vi.fn(),
    };

    const all = await getAddressTxsAll(provider, "addr1");
    expect(all).toHaveLength(80);
    expect(provider.getAddressTxsChainPage).toHaveBeenCalledWith("addr1", "tx49");
    expect(provider.getAddressTxsChainPage).toHaveBeenCalledWith("addr1", "tx74");
    expect(provider.getAddressTxsChainPage).toHaveBeenCalledWith("addr1", "tx79");
  });

  it("does not stop early when a chain page has fewer than 25 txs", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => makeTx(`tx${i}`));
    const page2 = [makeTx("tx50"), makeTx("tx51")];

    const provider: ChainProvider = {
      name: "mock",
      getAddressTxs: vi.fn().mockResolvedValue(page1),
      getAddressTxsChainPage: vi.fn().mockResolvedValueOnce(page2).mockResolvedValueOnce([]),
      getTx: vi.fn(),
      getAddressStats: vi.fn(),
    };

    const all = await getAddressTxsAll(provider, "addr1");
    expect(all).toHaveLength(52);
  });

  it("returns empty array for address with no txs", async () => {
    const provider: ChainProvider = {
      name: "mock",
      getAddressTxs: vi.fn().mockResolvedValue([]),
      getAddressTxsChainPage: vi.fn(),
      getTx: vi.fn(),
      getAddressStats: vi.fn(),
    };

    const all = await getAddressTxsAll(provider, "addr1");
    expect(all).toEqual([]);
    expect(provider.getAddressTxsChainPage).not.toHaveBeenCalled();
  });
});
