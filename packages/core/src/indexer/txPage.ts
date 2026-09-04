import type { AppConfig } from "../config.js";
import type { ChainTxDetail, ChainTxSummary } from "../chain/types.js";

export interface CompactPageSnapshot {
  status?: ChainTxSummary["status"];
  fee?: number;
  vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>;
  vout: Array<{ scriptpubkey_address?: string; value?: number }>;
}

export interface ClassifiedPendingTx {
  txid: string;
  isSpend?: boolean;
  voutCount?: number;
  outputAddressCount?: number;
  pageSnapshot?: CompactPageSnapshot;
}

export interface PendingTxRuntime extends ClassifiedPendingTx {
  pageEntry?: ChainTxSummary;
}

export interface ShouldSkipGetTxOpts {
  expandProfile?: string | null;
  pageEntry?: ChainTxSummary;
  hop?: number;
  traceHackerReceives?: boolean;
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

function compactPageSnapshot(entry: ChainTxSummary): CompactPageSnapshot {
  return {
    status: entry.status,
    fee: entry.fee,
    vin: (entry.vin ?? []).map((i) => ({
      prevout: i.prevout
        ? {
            scriptpubkey_address: i.prevout.scriptpubkey_address,
            value: i.prevout.value,
          }
        : undefined,
    })),
    vout: (entry.vout ?? []).map((o) => ({
      scriptpubkey_address: o.scriptpubkey_address,
      value: o.value,
    })),
  };
}

export function pageSnapshotToSummary(
  txid: string,
  snapshot: CompactPageSnapshot,
): ChainTxSummary {
  return {
    txid,
    status: snapshot.status,
    fee: snapshot.fee,
    vin: snapshot.vin,
    vout: snapshot.vout,
  };
}

function shouldSnapshotReceivePage(
  entry: PendingTxRuntime,
  maxVoutCountSkipGetTx: number,
): boolean {
  if (entry.isSpend !== false) return false;
  const voutCount = entry.voutCount ?? (entry.pageEntry ? txVoutCount(entry.pageEntry) : 0);
  if (voutCount > maxVoutCountSkipGetTx) return false;
  return Boolean(entry.pageEntry && hasPageVinVout(entry.pageEntry));
}

export function serializePendingTxs(
  pending: PendingTxRuntime[],
  opts?: { traceHackerReceives?: boolean; maxVoutCountSkipGetTx?: number },
): ClassifiedPendingTx[] {
  const maxVout = opts?.maxVoutCountSkipGetTx ?? Number.POSITIVE_INFINITY;
  return pending.map((entry) => {
    const base: ClassifiedPendingTx = {
      txid: entry.txid,
      ...(entry.isSpend !== undefined ? { isSpend: entry.isSpend } : {}),
      ...(entry.voutCount !== undefined ? { voutCount: entry.voutCount } : {}),
      ...(entry.outputAddressCount !== undefined
        ? { outputAddressCount: entry.outputAddressCount }
        : {}),
    };
    if (
      opts?.traceHackerReceives &&
      shouldSnapshotReceivePage(entry, maxVout) &&
      entry.pageEntry
    ) {
      base.pageSnapshot = compactPageSnapshot(entry.pageEntry);
    } else if (entry.pageSnapshot) {
      base.pageSnapshot = entry.pageSnapshot;
    }
    return base;
  });
}

export function parsePendingTxs(raw: Record<string, unknown>): ClassifiedPendingTx[] {
  const pendingTxs = raw.pendingTxs;
  if (Array.isArray(pendingTxs) && pendingTxs.length > 0) {
    return pendingTxs.map((entry) => {
      const e = entry as Record<string, unknown>;
      const pageSnapshot = e.pageSnapshot as CompactPageSnapshot | undefined;
      return {
        txid: String(e.txid),
        isSpend: typeof e.isSpend === "boolean" ? e.isSpend : undefined,
        voutCount: typeof e.voutCount === "number" ? e.voutCount : undefined,
        outputAddressCount:
          typeof e.outputAddressCount === "number" ? e.outputAddressCount : undefined,
        ...(pageSnapshot ? { pageSnapshot } : {}),
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

export function runtimeFromClassified(pending: ClassifiedPendingTx[]): PendingTxRuntime[] {
  return pending.map((entry) => ({
    ...entry,
    pageEntry:
      entry.pageSnapshot != null
        ? pageSnapshotToSummary(entry.txid, entry.pageSnapshot)
        : undefined,
  }));
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

export function shouldTraceHackerReceive(
  entry: ClassifiedPendingTx,
  config: AppConfig,
  opts?: ShouldSkipGetTxOpts,
): boolean {
  const hop = opts?.hop ?? 0;
  const trace = opts?.traceHackerReceives ?? config.traceFlaggedHackerReceives;
  if (entry.isSpend !== false) return false;
  if (opts?.expandProfile === "sweep_relay") return false;
  if (hop > 0) return false;
  if (!trace || hop !== 0) return false;
  const voutCount =
    entry.voutCount ??
    (opts?.pageEntry ? txVoutCount(opts.pageEntry) : entry.pageSnapshot?.vout.length ?? 0);
  return voutCount <= config.maxVoutCountSkipGetTx;
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
  opts?: ShouldSkipGetTxOpts,
): boolean {
  if (opts?.expandProfile === "sweep_relay" && entry.isSpend === false) return true;
  if (shouldTraceHackerReceive(entry, config, opts)) return false;
  if (entry.isSpend === false) return true;
  if (entry.isSpend === true) return false;

  const voutCount = entry.voutCount ?? (opts?.pageEntry ? txVoutCount(opts.pageEntry) : 0);
  if (voutCount > config.maxVoutCountSkipGetTx) {
    const pageEntry = opts?.pageEntry;
    if (pageEntry && !txInvolvesSpendFromPage(pageEntry, address)) return true;
  }
  return false;
}
