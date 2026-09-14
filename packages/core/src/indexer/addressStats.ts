import type { Store } from "@cointrace/db";
import type { ChainAddressStats } from "../chain/types.js";
import type { ChainRouter } from "../chain/router.js";

export function liveBalanceSatsFromStats(stats: ChainAddressStats): number {
  const funded = (stats.chain_stats.funded_txo_sum ?? 0) + (stats.mempool_stats?.funded_txo_sum ?? 0);
  const spent = (stats.chain_stats.spent_txo_sum ?? 0) + (stats.mempool_stats?.spent_txo_sum ?? 0);
  return funded - spent;
}

export function observedTxCountFromStats(stats: ChainAddressStats): number {
  return (stats.chain_stats.tx_count ?? 0) + (stats.mempool_stats?.tx_count ?? 0);
}

export async function applyAddressStats(
  store: Store,
  address: string,
  stats: ChainAddressStats,
): Promise<{ liveBalanceSats: number; observedTxCount: number }> {
  const liveBalanceSats = liveBalanceSatsFromStats(stats);
  const observedTxCount = observedTxCountFromStats(stats);
  await store.upsertAddress({
    address,
    liveBalanceSats,
    liveBalanceAt: new Date().toISOString(),
  });
  return { liveBalanceSats, observedTxCount };
}

export function canSkipAddressTxsPoll(opts: {
  lastSeenTxid?: string | null;
  lastObservedTxCount?: number | null;
  observedTxCount: number;
}): boolean {
  if (!opts.lastSeenTxid) return false;
  if (opts.lastObservedTxCount == null) return false;
  return opts.lastObservedTxCount === opts.observedTxCount;
}

export async function probePollAddressStats(
  store: Store,
  router: ChainRouter,
  address: string,
): Promise<{ observedTxCount: number; skipTxs: boolean }> {
  const stats = await router.withProvider((p) => p.getAddressStats(address));
  const { observedTxCount } = await applyAddressStats(store, address, stats);
  const sync = await store.getSyncState(address);
  return {
    observedTxCount,
    skipTxs: canSkipAddressTxsPoll({
      lastSeenTxid: sync?.lastSeenTxid,
      lastObservedTxCount: sync?.lastObservedTxCount,
      observedTxCount,
    }),
  };
}

export function lastObservedTxCountPatch(
  count?: number,
): { lastObservedTxCount: number } | Record<string, never> {
  return count != null ? { lastObservedTxCount: count } : {};
}

/** Skip a dedicated balance job when poll or audit will already fetch address stats. */
export function shouldEnqueueRefreshLiveBalance(opts: {
  balanceStale: boolean;
  pollDue: boolean;
  auditDue: boolean;
}): boolean {
  return opts.balanceStale && !opts.pollDue && !opts.auditDue;
}
