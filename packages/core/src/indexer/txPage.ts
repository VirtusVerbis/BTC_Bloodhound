import type { AppConfig } from "../config.js";
import type { ChainTxDetail, ChainTxSummary } from "../chain/types.js";

export interface ClassifiedPendingTx {
  txid: string;
  isSpend?: boolean;
  voutCount?: number;
  outputAddressCount?: number;
}

export interface PendingTxRuntime extends ClassifiedPendingTx {
  pageEntry?: ChainTxSummary;
}

export function txInvolvesSpendFromPage(tx: ChainTxSummary, address: string): boolean {
  if (!tx.vin?.length) return false;
  return tx.vin.some((i) => i.prevout?.scriptpubkey_address === address);
}

export function txVoutCount(tx: ChainTxSummary): number {
  return tx.vout?.length ?? 0;
}

export function uniqueOutputAddresses(tx: ChainTxSummary): number {
  if (!tx.vout?.length) return 0;
  const seen = new Set<string>();
  for (const o of tx.vout) {
    const addr = o.scriptpubkey_address;
    if (addr) seen.add(addr);
  }
  return seen.size;
}

export function classifyPageTx(
  tx: ChainTxSummary,
  address: string,
): ClassifiedPendingTx {
  const isSpend = tx.vin?.length ? txInvolvesSpendFromPage(tx, address) : undefined;
  return {
    txid: tx.txid,
    isSpend,
    voutCount: txVoutCount(tx),
    outputAddressCount: uniqueOutputAddresses(tx),
  };
}

export function classifyPageTxs(txs: ChainTxSummary[], address: string): PendingTxRuntime[] {
  return txs.map((pageEntry) => ({
    ...classifyPageTx(pageEntry, address),
    pageEntry,
  }));
}

export function pendingFromLegacyTxids(txids: string[]): ClassifiedPendingTx[] {
  return txids.map((txid) => ({ txid }));
}

export function serializePendingTxs(pending: ClassifiedPendingTx[]): ClassifiedPendingTx[] {
  return pending.map(({ txid, isSpend, voutCount, outputAddressCount }) => ({
    txid,
    ...(isSpend !== undefined ? { isSpend } : {}),
    ...(voutCount !== undefined ? { voutCount } : {}),
    ...(outputAddressCount !== undefined ? { outputAddressCount } : {}),
  }));
}

export function parsePendingTxs(raw: Record<string, unknown>): ClassifiedPendingTx[] {
  const pendingTxs = raw.pendingTxs;
  if (Array.isArray(pendingTxs) && pendingTxs.length > 0) {
    return pendingTxs.map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        txid: String(e.txid),
        isSpend: typeof e.isSpend === "boolean" ? e.isSpend : undefined,
        voutCount: typeof e.voutCount === "number" ? e.voutCount : undefined,
        outputAddressCount:
          typeof e.outputAddressCount === "number" ? e.outputAddressCount : undefined,
      };
    });
  }
  const pendingTxids = raw.pendingTxids;
  if (Array.isArray(pendingTxids) && pendingTxids.length > 0) {
    return pendingFromLegacyTxids(pendingTxids as string[]);
  }
  return [];
}

export function pendingTxidsFromPending(pending: ClassifiedPendingTx[]): string[] {
  return pending.map((p) => p.txid);
}

export function pageEntryToChainTxDetail(entry: ChainTxSummary): ChainTxDetail {
  return {
    txid: entry.txid,
    status: entry.status,
    fee: entry.fee,
    vin: entry.vin ?? [],
    vout: entry.vout ?? [],
  };
}

export function hasPageVinVout(entry: ChainTxSummary): boolean {
  return Boolean(entry.vin?.length && entry.vout?.length);
}

export function isSpendFanout(
  entry: ClassifiedPendingTx,
  address: string,
  config: AppConfig,
  pageEntry?: ChainTxSummary,
): boolean {
  if (entry.isSpend === false) return false;
  const voutCount = entry.voutCount ?? (pageEntry ? txVoutCount(pageEntry) : 0);
  const outputAddressCount =
    entry.outputAddressCount ?? (pageEntry ? uniqueOutputAddresses(pageEntry) : 0);
  if (voutCount < config.spendFanoutMinVoutCount) return false;
  if (outputAddressCount < config.spendFanoutMinOutputAddresses) return false;
  if (entry.isSpend === true) return true;
  if (pageEntry && txInvolvesSpendFromPage(pageEntry, address)) return true;
  return false;
}

export function shouldSkipGetTx(
  entry: ClassifiedPendingTx,
  address: string,
  config: AppConfig,
  opts?: { expandProfile?: string | null; pageEntry?: ChainTxSummary },
): boolean {
  if (opts?.expandProfile === "sweep_relay" && entry.isSpend === false) return true;
  if (entry.isSpend === false) return true;
  if (entry.isSpend === true) return false;

  const voutCount = entry.voutCount ?? (opts?.pageEntry ? txVoutCount(opts.pageEntry) : 0);
  if (voutCount > config.maxVoutCountSkipGetTx) {
    const pageEntry = opts?.pageEntry;
    if (pageEntry && !txInvolvesSpendFromPage(pageEntry, address)) return true;
  }
  return false;
}
