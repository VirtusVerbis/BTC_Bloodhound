import type { ClassifiedPendingTx } from "./txPage.js";

export interface RelayMeta {
  receiveTxCount: number;
  spendTxCount: number;
  primarySweepTarget?: string;
  totalReceivedSats?: number;
}

export interface SweepRelayDetectionInput {
  entries: ClassifiedPendingTx[];
  spendTargets: string[];
}

export interface SweepRelayConfig {
  sweepRelayMinReceiveRatio: number;
  sweepRelayMinVoutCount: number;
  sweepRelayMinSpendTargetShare: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function primaryTargetShare(targets: string[]): { target: string; share: number } | null {
  if (targets.length === 0) return null;
  const counts = new Map<string, number>();
  for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [target, count] of counts) {
    if (count > bestCount) {
      best = target;
      bestCount = count;
    }
  }
  return { target: best, share: bestCount / targets.length };
}

export function detectSweepRelay(
  input: SweepRelayDetectionInput,
  config: SweepRelayConfig,
): { matched: boolean; meta?: RelayMeta } {
  const receives = input.entries.filter((e) => e.isSpend === false);
  const spends = input.entries.filter((e) => e.isSpend === true);
  const classified = receives.length + spends.length;
  if (classified === 0) return { matched: false };

  const receiveRatio = receives.length / classified;
  if (receiveRatio < config.sweepRelayMinReceiveRatio) return { matched: false };

  const receiveVouts = receives
    .map((e) => e.voutCount ?? 0)
    .filter((n) => n > 0);
  if (receiveVouts.length === 0) return { matched: false };
  if (median(receiveVouts) < config.sweepRelayMinVoutCount) return { matched: false };

  const primary = primaryTargetShare(input.spendTargets);
  if (!primary || primary.share < config.sweepRelayMinSpendTargetShare) return { matched: false };

  return {
    matched: true,
    meta: {
      receiveTxCount: receives.length,
      spendTxCount: spends.length,
      primarySweepTarget: primary.target,
    },
  };
}
