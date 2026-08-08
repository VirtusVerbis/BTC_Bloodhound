import { EsploraProvider, getAddressTxsAll, isRateLimitError, MempoolProvider } from "./esplora.js";
import type { ChainProvider, ChainTxSummary } from "./types.js";
import type { Store } from "@cointrace/db";

/** Thrown when rate limit window is not ready and sleeping is disabled (Workers). */
export class RateLimitNotReadyError extends Error {
  readonly retryAt: string;

  constructor(retryAt: string) {
    super(`Rate limit not ready until ${retryAt}`);
    this.name = "RateLimitNotReadyError";
    this.retryAt = retryAt;
  }
}

export interface ChainRouterOptions {
  /** When false, throw RateLimitNotReadyError instead of sleeping (Cloudflare Workers). Default true. */
  sleepOnRateLimit?: boolean;
}

export class ChainRouter {
  private providers: ChainProvider[];
  private index = 0;
  private sleepOnRateLimit: boolean;

  constructor(
    esploraBase: string,
    mempoolBase: string,
    private store: Store,
    private rateLimitMs: number,
    options?: ChainRouterOptions,
  ) {
    this.providers = [new EsploraProvider(esploraBase), new MempoolProvider(mempoolBase)];
    this.sleepOnRateLimit = options?.sleepOnRateLimit ?? true;
  }

  private async waitForRateLimit(): Promise<void> {
    const state = await this.store.getSchedulerState();
    const nextAtIso = state?.nextProviderCallAt ?? null;
    const nextAt = nextAtIso ? new Date(nextAtIso).getTime() : 0;
    const wait = Math.max(0, nextAt - Date.now());
    if (wait <= 0) return;
    if (!this.sleepOnRateLimit) {
      throw new RateLimitNotReadyError(nextAtIso ?? new Date(Date.now() + wait).toISOString());
    }
    await new Promise((r) => setTimeout(r, wait));
  }

  private async markCalled(providerName: string, success: boolean) {
    const next = new Date(Date.now() + this.rateLimitMs).toISOString();
    await this.store.updateSchedulerState({
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
      await this.markCalled(provider.name, true);
      return result;
    } catch (err) {
      await this.markCalled(provider.name, false);
      if (isRateLimitError(err)) {
        await this.store.recordApiThreshold();
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
