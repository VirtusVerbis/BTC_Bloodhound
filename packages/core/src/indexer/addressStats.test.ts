import { describe, expect, it, vi } from "vitest";
import type { Store } from "@cointrace/db";
import type { ChainAddressStats } from "../chain/types.js";
import {
  applyAddressStats,
  canSkipAddressTxsPoll,
  lastObservedTxCountPatch,
  liveBalanceSatsFromStats,
  observedTxCountFromStats,
  shouldEnqueueRefreshLiveBalance,
} from "./addressStats.js";

const stats = (overrides: Partial<ChainAddressStats["chain_stats"]> = {}, mempool?: ChainAddressStats["mempool_stats"]): ChainAddressStats => ({
  chain_stats: {
    funded_txo_sum: 1000,
    spent_txo_sum: 400,
    tx_count: 10,
    ...overrides,
  },
  ...(mempool ? { mempool_stats: mempool } : {}),
});

describe("address stats helpers", () => {
  it("computes live balance from chain plus mempool sums", () => {
    expect(
      liveBalanceSatsFromStats(
        stats({}, { funded_txo_sum: 50, spent_txo_sum: 10, tx_count: 1 }),
      ),
    ).toBe(640);
  });

  it("treats missing mempool_stats as zero for balance and count", () => {
    expect(liveBalanceSatsFromStats(stats())).toBe(600);
    expect(observedTxCountFromStats(stats())).toBe(10);
  });

  it("adds mempool tx_count to observed total", () => {
    expect(observedTxCountFromStats(stats({}, { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 2 }))).toBe(12);
    expect(observedTxCountFromStats(stats({}, { funded_txo_sum: 0, spent_txo_sum: 0 }))).toBe(10);
  });

  it("writes live balance via applyAddressStats", async () => {
    const upsertAddress = vi.fn();
    const store = { upsertAddress } as unknown as Store;
    const result = await applyAddressStats(store, "bc1q", stats({ funded_txo_sum: 200, spent_txo_sum: 50, tx_count: 3 }));
    expect(result.liveBalanceSats).toBe(150);
    expect(result.observedTxCount).toBe(3);
    expect(upsertAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "bc1q",
        liveBalanceSats: 150,
        liveBalanceAt: expect.any(String),
      }),
    );
  });

  it("skips /txs only when lastSeen and stored count both match", () => {
    expect(
      canSkipAddressTxsPoll({ lastSeenTxid: "tip", lastObservedTxCount: 10, observedTxCount: 10 }),
    ).toBe(true);
    expect(
      canSkipAddressTxsPoll({ lastSeenTxid: null, lastObservedTxCount: 10, observedTxCount: 10 }),
    ).toBe(false);
    expect(
      canSkipAddressTxsPoll({ lastSeenTxid: "tip", lastObservedTxCount: null, observedTxCount: 10 }),
    ).toBe(false);
    expect(
      canSkipAddressTxsPoll({ lastSeenTxid: "tip", lastObservedTxCount: 9, observedTxCount: 10 }),
    ).toBe(false);
  });

  it("patches lastObservedTxCount only when defined", () => {
    expect(lastObservedTxCountPatch(7)).toEqual({ lastObservedTxCount: 7 });
    expect(lastObservedTxCountPatch(undefined)).toEqual({});
  });

  it("skips refresh enqueue when poll or audit will fetch stats", () => {
    expect(shouldEnqueueRefreshLiveBalance({ balanceStale: true, pollDue: true, auditDue: false })).toBe(false);
    expect(shouldEnqueueRefreshLiveBalance({ balanceStale: true, pollDue: false, auditDue: true })).toBe(false);
    expect(shouldEnqueueRefreshLiveBalance({ balanceStale: true, pollDue: false, auditDue: false })).toBe(true);
    expect(shouldEnqueueRefreshLiveBalance({ balanceStale: false, pollDue: false, auditDue: false })).toBe(false);
  });
});
