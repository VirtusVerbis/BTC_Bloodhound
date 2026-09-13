import type { ChainTxSummary } from "../chain/types.js";
import {
  classifyPageTxs,
  pageEntryHasOpReturnAsm,
  type PendingTxRuntime,
} from "./txPage.js";

export function sliceNewerThanLastSeen(
  txs: ChainTxSummary[],
  lastSeenTxid?: string | null,
): { newer: ChainTxSummary[]; lastSeenFound: boolean; lastSeenIndex: number } {
  if (!lastSeenTxid) {
    return { newer: txs, lastSeenFound: true, lastSeenIndex: -1 };
  }
  const lastSeenIndex = txs.findIndex((t) => t.txid === lastSeenTxid);
  if (lastSeenIndex === -1) {
    return { newer: txs, lastSeenFound: false, lastSeenIndex: -1 };
  }
  return { newer: txs.slice(0, lastSeenIndex), lastSeenFound: true, lastSeenIndex };
}

export function pendingGapFillTxs(txs: ChainTxSummary[], address: string): PendingTxRuntime[] {
  return classifyPageTxs(txs, address).filter(
    (entry) =>
      entry.isSpend === true ||
      (entry.pageEntry != null && pageEntryHasOpReturnAsm(entry.pageEntry)),
  );
}

export function spendGapExceedsFloor(
  chainSpentSats: number,
  indexedOutSats: number,
  minExpandSats: number,
): boolean {
  const floor = Math.max(0, Math.floor(minExpandSats));
  return chainSpentSats - indexedOutSats >= floor;
}
