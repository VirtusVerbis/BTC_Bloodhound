import type { Store } from "@cointrace/db";
import { blockTimeIso } from "../chain/esplora.js";
import type { ChainTxDetail } from "../chain/types.js";
import type { AppConfig } from "../config.js";
import { pageEntryToChainTxDetail, uniqueOutputAddresses, type PendingTxRuntime } from "./txPage.js";

export interface FanoutOutput {
  address: string;
  sats: number;
}

export interface FanoutMeta {
  txid: string;
  outputCount: number;
  totalOutSats: number;
  topOutputs: FanoutOutput[];
}

export interface SpendFanoutConfig {
  spendFanoutTopK: number;
}

export function aggregateFanoutOutputs(
  tx: ChainTxDetail,
  spender: string,
): { outputCount: number; totalOutSats: number; topOutputs: FanoutOutput[] } {
  const byAddress = new Map<string, number>();
  for (const o of tx.vout) {
    const addr = o.scriptpubkey_address;
    const value = o.value ?? 0;
    if (!addr || addr === spender || value <= 0) continue;
    byAddress.set(addr, (byAddress.get(addr) ?? 0) + value);
  }
  const outputs = [...byAddress.entries()].map(([address, sats]) => ({ address, sats }));
  const totalOutSats = outputs.reduce((sum, o) => sum + o.sats, 0);
  return {
    outputCount: uniqueOutputAddresses(tx),
    totalOutSats,
    topOutputs: outputs.sort((a, b) => b.sats - a.sats),
  };
}

export function buildFanoutMeta(
  tx: ChainTxDetail,
  spender: string,
  config: SpendFanoutConfig,
): FanoutMeta {
  const agg = aggregateFanoutOutputs(tx, spender);
  return {
    txid: tx.txid,
    outputCount: agg.outputCount,
    totalOutSats: agg.totalOutSats,
    topOutputs: agg.topOutputs.slice(0, config.spendFanoutTopK),
  };
}

export async function applySpendFanoutSummary(
  store: Store,
  tx: ChainTxDetail,
  spender: string,
  hop: number,
  config: SpendFanoutConfig,
): Promise<FanoutMeta> {
  const meta = buildFanoutMeta(tx, spender, config);
  const primary = meta.topOutputs[0];
  if (!primary) {
    await store.upsertTransaction({
      txid: tx.txid,
      blockHeight: tx.status?.block_height ?? null,
      blockTime: blockTimeIso(tx),
      feeSats: tx.fee ?? null,
    });
    return meta;
  }

  await store.upsertTransaction({
    txid: tx.txid,
    blockHeight: tx.status?.block_height ?? null,
    blockTime: blockTimeIso(tx),
    feeSats: tx.fee ?? null,
  });

  await store.upsertEdge({
    fromAddress: spender,
    toAddress: primary.address,
    txid: tx.txid,
    amountSats: meta.totalOutSats,
    blockTime: blockTimeIso(tx),
    hopFromHacker: hop + 1,
    direction: "out_from_hacker",
    edgeKind: "spend_fanout",
    fanoutMetaJson: JSON.stringify(meta),
  });

  await store.upsertAddress({
    address: primary.address,
    role: "downstream",
    source: "derived",
    hopFromHacker: hop + 1,
    expandStatus: "pending",
  });

  await store.setExpandProfile(spender, "spend_fanout", { fanoutMetaJson: JSON.stringify(meta) });

  return meta;
}

export function spendFanoutTxFromPage(entry: PendingTxRuntime): ChainTxDetail | null {
  if (!entry.pageEntry?.vin?.length || !entry.pageEntry?.vout?.length) return null;
  return pageEntryToChainTxDetail(entry.pageEntry);
}
