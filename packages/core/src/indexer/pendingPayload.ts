import type { AppConfig } from "../config.js";
import type { ChainTxSummary } from "../chain/types.js";
import {
  classifyPageTxs,
  parsePendingTxs,
  pendingTxidsFromPending,
  runtimeFromClassified,
  serializePendingTxs,
  type ClassifiedPendingTx,
  type PendingTxRuntime,
} from "./txPage.js";

export interface PendingPayloadFields {
  pendingTxs?: ClassifiedPendingTx[];
  pendingTxids?: string[];
  processedIndex?: number;
}

export function pendingFromPageTxs(txs: ChainTxSummary[], address: string): PendingTxRuntime[] {
  return classifyPageTxs(txs, address);
}

export function readPendingRuntime(raw: Record<string, unknown>): {
  pending: PendingTxRuntime[];
  processedIndex: number;
} {
  const pending = runtimeFromClassified(parsePendingTxs(raw));
  const processedIndex = typeof raw.processedIndex === "number" ? raw.processedIndex : 0;
  return { pending, processedIndex };
}

export function writePendingPayload(
  pending: PendingTxRuntime[],
  processedIndex: number,
  config?: Pick<AppConfig, "traceFlaggedHackerReceives" | "maxVoutCountSkipGetTx">,
): PendingPayloadFields {
  const hasPending = processedIndex < pending.length;
  const serializeOpts = config
    ? {
        traceHackerReceives: config.traceFlaggedHackerReceives,
        maxVoutCountSkipGetTx: config.maxVoutCountSkipGetTx,
      }
    : undefined;
  return {
    pendingTxs: hasPending ? serializePendingTxs(pending, serializeOpts) : [],
    pendingTxids: hasPending ? pendingTxidsFromPending(pending) : [],
    processedIndex: hasPending ? processedIndex : 0,
  };
}

export function collectSpendTargetsFromRuntime(entries: PendingTxRuntime[]): string[] {
  const targets: string[] = [];
  for (const entry of entries) {
    if (entry.isSpend !== true || !entry.pageEntry?.vout) continue;
    for (const o of entry.pageEntry.vout) {
      const addr = o.scriptpubkey_address;
      if (addr) targets.push(addr);
    }
  }
  return targets;
}
