import { EsploraProvider, isRateLimitError, MempoolProvider, rateLimitRetryAfterSec } from "./esplora.js";
import type { ChainProvider, ChainTxSummary } from "./types.js";
import type { Store, ChainApiProviderId } from "@cointrace/db";
import { providerBackoffSec } from "./backoff.js";

/** Thrown when rate limit window is not ready and sleeping is disabled (Workers). */
export class RateLimitNotReadyError extends Error {
  readonly retryAt: string;

  constructor(retryAt: string) {
    super(`Rate limit not ready until ${retryAt}`);
    this.name = "RateLimitNotReadyError";
    this.retryAt = retryAt;
  }
}

export interface ChainRouterBackoffConfig {
  rateLimitMs: number;
  apiThresholdBaseSec: number;
  apiThresholdMaxSec: number;
}

export interface ChainRouterOptions {
  /** When false, throw RateLimitNotReadyError instead of sleeping (Cloudflare Workers). Default true. */
  sleepOnRateLimit?: boolean;
  backoff?: ChainRouterBackoffConfig;
}

export class ChainRouter {
  private providers: ChainProvider[];
  private index = 0;
  private sleepOnRateLimit: boolean;
  private backoff: ChainRouterBackoffConfig;

  constructor(
    esploraBase: string,
    mempoolBase: string,
    private store: Store,
    rateLimitMs: number,
    options?: ChainRouterOptions,
  ) {
    this.providers = [new EsploraProvider(esploraBase), new MempoolProvider(mempoolBase)];
    this.sleepOnRateLimit = options?.sleepOnRateLimit ?? true;
    this.backoff = options?.backoff ?? {
      rateLimitMs,
      apiThresholdBaseSec: 300,
      apiThresholdMaxSec: 3600,
    };
  }

  private providerId(name: string): ChainApiProviderId {
    return name === "esplora" ? "esplora" : "mempool";
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

  private async resolveAvailableProvider(
    state: Awaited<ReturnType<Store["getSchedulerState"]>>,
    preferAlternate: boolean,
  ): Promise<ChainProvider | null> {
    const start = preferAlternate ? (this.index + 1) % this.providers.length : this.index;
    for (let offset = 0; offset < this.providers.length; offset++) {
      const idx = (start + offset) % this.providers.length;
      const provider = this.providers[idx]!;
      const id = this.providerId(provider.name);
      if (!this.store.isProviderInBackoff(state, id)) {
        this.index = (idx + 1) % this.providers.length;
        return provider;
      }
    }
    return null;
  }

  private async markCalled(providerName: string, success: boolean, nextAtOverride?: string) {
    const next =
      nextAtOverride ?? new Date(Date.now() + this.backoff.rateLimitMs).toISOString();
    await this.store.updateSchedulerState({
      nextProviderCallAt: next,
      lastProviderUsed: providerName,
      rateLimitMs: this.backoff.rateLimitMs,
      ...(success ? { lastProviderSuccessAt: new Date().toISOString() } : {}),
    });
  }

  private maxIso(a: string | null | undefined, b: string): string {
    if (!a) return b;
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  }

  async withProvider<T>(fn: (p: ChainProvider) => Promise<T>, preferAlternate = false): Promise<T> {
    await this.waitForRateLimit();
    const state = await this.store.getSchedulerState();
    const provider = await this.resolveAvailableProvider(state, preferAlternate);
    if (!provider) {
      const retryAt = (await this.store.earliestProviderRetryAt()) ?? new Date(Date.now() + 60_000).toISOString();
      throw new RateLimitNotReadyError(retryAt);
    }
    const providerId = this.providerId(provider.name);
    try {
      const result = await fn(provider);
      await this.store.clearProviderStrike(providerId);
      await this.markCalled(provider.name, true);
      return result;
    } catch (err) {
      if (isRateLimitError(err)) {
        const strikes = this.store.getProviderStrikeCount(state, providerId) + 1;
        const retryAfterSec = rateLimitRetryAfterSec(err);
        const backoffSec = providerBackoffSec(
          strikes,
          this.backoff.apiThresholdBaseSec,
          this.backoff.apiThresholdMaxSec,
          retryAfterSec ?? undefined,
        );
        const retryAfterAt = new Date(Date.now() + backoffSec * 1000).toISOString();
        await this.store.recordApiThreshold(providerId, { retryAfterAt, strikeCount: strikes });
        const nextGlobal = this.maxIso(state?.nextProviderCallAt, retryAfterAt);
        await this.markCalled(provider.name, false, nextGlobal);
      } else {
        await this.markCalled(provider.name, false);
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
}
