import { EsploraProvider, getAddressTxsAll, isRateLimitError, MempoolProvider } from "./esplora.js";
import type { ChainProvider, ChainTxSummary } from "./types.js";
import type { Store } from "@cointrace/db";

export class ChainRouter {
  private providers: ChainProvider[];
  private index = 0;

  constructor(
    esploraBase: string,
    mempoolBase: string,
    private store: Store,
    private rateLimitMs: number,
  ) {
    this.providers = [new EsploraProvider(esploraBase), new MempoolProvider(mempoolBase)];
  }

  private async waitForRateLimit(): Promise<void> {
    const state = this.store.getSchedulerState();
    const nextAt = state?.nextProviderCallAt ? new Date(state.nextProviderCallAt).getTime() : 0;
    const wait = Math.max(0, nextAt - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private markCalled(providerName: string, success: boolean) {
    const next = new Date(Date.now() + this.rateLimitMs).toISOString();
    this.store.updateSchedulerState({
      nextProviderCallAt: next,
      lastProviderUsed: providerName,
      rateLimitMs: this.rateLimitMs,
      ...(success ? { lastProviderSuccessAt: new Date().toISOString() } : {}),
    });
  }

  async withProvider<T>(fn: (p: ChainProvider) => Promise<T>, preferAlternate = false): Promise<T> {
    await this.waitForRateLimit();
    if (preferAlternate) this.index = (this.index + 1) % this.providers.length;
    const provider = this.providers[this.index]!;
    this.index = (this.index + 1) % this.providers.length;
    try {
      const result = await fn(provider);
      this.markCalled(provider.name, true);
      return result;
    } catch (err) {
      this.markCalled(provider.name, false);
      if (isRateLimitError(err)) {
        this.store.recordApiThreshold();
      }
      throw err;
    }
  }

  async fetchAddressTxPage(
    address: string,
    chainCursor?: string,
  ): Promise<{ txs: ChainTxSummary[] }> {
    const txs = chainCursor
      ? await this.withProvider((p) => p.getAddressTxsChainPage(address, chainCursor))
      : await this.withProvider((p) => p.getAddressTxs(address));
    return { txs };
  }

  async fetchAddressTxsAll(address: string, maxTxs?: number): Promise<ChainTxSummary[]> {
    return getAddressTxsAll(
      {
        fetchFirstPage: (addr) => this.withProvider((p) => p.getAddressTxs(addr)),
        fetchChainPage: (addr, lastTxid) =>
          this.withProvider((p) => p.getAddressTxsChainPage(addr, lastTxid)),
      },
      address,
      { maxTxs },
    );
  }
}
