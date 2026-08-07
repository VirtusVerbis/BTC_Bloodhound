import type { ChainAddressStats, ChainProvider, ChainTxDetail, ChainTxSummary } from "./types.js";

type TxPage = Array<{ txid: string; status?: { block_height?: number; block_time?: number }; fee?: number }>;

export class EsploraProvider implements ChainProvider {
  name = "esplora";

  constructor(private base: string) {}

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "cointrace-indexer/1.0" },
    });
    if (!res.ok) throw new Error(`Esplora ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  async getAddressTxs(address: string, lastSeenTxid?: string): Promise<ChainTxSummary[]> {
    const txs = await this.fetchJson<TxPage>(`/address/${address}/txs`);
    if (!lastSeenTxid) return txs;
    const idx = txs.findIndex((t) => t.txid === lastSeenTxid);
    return idx === -1 ? txs : txs.slice(0, idx);
  }

  async getAddressTxsChainPage(address: string, lastTxid: string): Promise<ChainTxSummary[]> {
    return this.fetchJson<TxPage>(`/address/${address}/txs/chain/${lastTxid}`);
  }

  async getTx(txid: string): Promise<ChainTxDetail> {
    return this.fetchJson<ChainTxDetail>(`/tx/${txid}`);
  }

  async getAddressStats(address: string): Promise<ChainAddressStats> {
    return this.fetchJson<ChainAddressStats>(`/address/${address}`);
  }
}

export class MempoolProvider implements ChainProvider {
  name = "mempool";

  constructor(private base: string) {}

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "cointrace-indexer/1.0" },
    });
    if (!res.ok) throw new Error(`Mempool ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  async getAddressTxs(address: string, lastSeenTxid?: string): Promise<ChainTxSummary[]> {
    const txs = await this.fetchJson<TxPage>(`/address/${address}/txs`);
    if (!lastSeenTxid) return txs;
    const idx = txs.findIndex((t) => t.txid === lastSeenTxid);
    return idx === -1 ? txs : txs.slice(0, idx);
  }

  async getAddressTxsChainPage(address: string, lastTxid: string): Promise<ChainTxSummary[]> {
    return this.fetchJson<TxPage>(`/address/${address}/txs/chain/${lastTxid}`);
  }

  async getTx(txid: string): Promise<ChainTxDetail> {
    return this.fetchJson<ChainTxDetail>(`/tx/${txid}`);
  }

  async getAddressStats(address: string): Promise<ChainAddressStats> {
    return this.fetchJson<ChainAddressStats>(`/address/${address}`);
  }
}

export function blockTimeIso(tx: ChainTxSummary | ChainTxDetail): string | null {
  const t = tx.status?.block_time;
  return t ? new Date(t * 1000).toISOString() : null;
}

export async function getAddressTxsAll(
  provider: ChainProvider,
  address: string,
  opts?: { maxTxs?: number },
): Promise<ChainTxSummary[]> {
  const maxTxs = opts?.maxTxs ?? 1000;
  const all: ChainTxSummary[] = [];
  let page = await provider.getAddressTxs(address);

  while (page.length > 0) {
    all.push(...page);
    if (all.length >= maxTxs || page.length < 25) break;
    const lastTxid = page[page.length - 1]!.txid;
    page = await provider.getAddressTxsChainPage(address, lastTxid);
  }

  return all.slice(0, maxTxs);
}

export function txInvolvesSpend(tx: ChainTxDetail, address: string): boolean {
  return tx.vin.some((i) => i.prevout?.scriptpubkey_address === address);
}
