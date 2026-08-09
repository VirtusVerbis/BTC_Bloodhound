import type { ChainAddressStats, ChainProvider, ChainTxDetail, ChainTxSummary } from "./types.js";

type TxPage = Array<{ txid: string; status?: { block_height?: number; block_time?: number }; fee?: number }>;

export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("429") || msg.includes("too many requests");
}

export function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isRateLimitError(err)) return true;
  const msg = err.message.toLowerCase();
  if (msg.includes("fetch failed") || msg.includes("etimedout") || msg.includes("econnreset")) {
    return true;
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ENOTFOUND";
  }
  return false;
}

async function fetchJsonWithRetry<T>(
  base: string,
  providerName: string,
  path: string,
  maxRetries = 3,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { Accept: "application/json", "User-Agent": "cointrace-indexer/1.0" },
      });
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter
          ? Math.max(1000, Number(retryAfter) * 1000)
          : Math.min(30000, 1000 * 2 ** attempt);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`${providerName} ${path}: 429 Too Many Requests`);
      }
      if (!res.ok) throw new Error(`${providerName} ${path}: ${res.status}`);
      return res.json() as Promise<T>;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries && isRateLimitError(lastErr)) {
        await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`${providerName} ${path}: fetch failed`);
}

export class EsploraProvider implements ChainProvider {
  name = "esplora";

  constructor(private base: string) {}

  private fetchJson<T>(path: string): Promise<T> {
    return fetchJsonWithRetry<T>(this.base, "Esplora", path);
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

  private fetchJson<T>(path: string): Promise<T> {
    return fetchJsonWithRetry<T>(this.base, "Mempool", path);
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

export interface AddressTxPageFetcher {
  fetchFirstPage(address: string): Promise<ChainTxSummary[]>;
  fetchChainPage(address: string, lastTxid: string): Promise<ChainTxSummary[]>;
}

function asPageFetcher(source: AddressTxPageFetcher | ChainProvider): AddressTxPageFetcher {
  if ("fetchFirstPage" in source) return source;
  return {
    fetchFirstPage: (address) => source.getAddressTxs(address),
    fetchChainPage: (address, lastTxid) => source.getAddressTxsChainPage(address, lastTxid),
  };
}

export async function getAddressTxsAll(
  source: AddressTxPageFetcher | ChainProvider,
  address: string,
  opts?: { maxTxs?: number },
): Promise<ChainTxSummary[]> {
  const maxTxs = opts?.maxTxs ?? 10000;
  const fetcher = asPageFetcher(source);
  const all: ChainTxSummary[] = [];

  let page = await fetcher.fetchFirstPage(address);
  if (page.length === 0) return [];

  all.push(...page);
  while (all.length < maxTxs) {
    const lastTxid = page[page.length - 1]!.txid;
    page = await fetcher.fetchChainPage(address, lastTxid);
    if (page.length === 0) break;
    all.push(...page);
  }

  return all.slice(0, maxTxs);
}

export function txInvolvesSpend(tx: ChainTxDetail, address: string): boolean {
  return tx.vin.some((i) => i.prevout?.scriptpubkey_address === address);
}
