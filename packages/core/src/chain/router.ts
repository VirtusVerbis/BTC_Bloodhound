import { EsploraProvider, isRateLimitError, MempoolProvider, rateLimitRetryAfterSec } from "./esplora.js";
import type { ChainProvider, ChainTxSummary } from "./types.js";
import type { Store, ChainApiProviderId } from "@cointrace/db";
import { providerBackoffSec } from "./backoff.js";

export type RateLimitNotReadyReason = "pacing" | "provider-backoff";

export type ChainPrimaryProvider = "esplora" | "mempool";

function formatRateLimitNotReadyMessage(retryAt: string, reason: RateLimitNotReadyReason): string {
  if (reason === "pacing") {
    return `Provider pacing: next call allowed at ${retryAt}`;
  }
  return `All providers in backoff until ${retryAt}`;
}

/** Thrown when rate limit window is not ready and sleeping is disabled (Workers). */
export class RateLimitNotReadyError extends Error {
  readonly retryAt: string;
  readonly reason: RateLimitNotReadyReason;

  constructor(retryAt: string, reason: RateLimitNotReadyReason) {
    super(formatRateLimitNotReadyMessage(retryAt, reason));
    this.name = "RateLimitNotReadyError";
    this.retryAt = retryAt;
    this.reason = reason;
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
  /** First provider on cold start when lastProviderUsed is unset. Default esplora. */
  primaryProvider?: ChainPrimaryProvider;
}

export class ChainRouter {
  private providers: ChainProvider[];
  private sleepOnRateLimit: boolean;
  private backoff: ChainRouterBackoffConfig;
  private primaryProvider: ChainPrimaryProvider;

  constructor(
    esploraBase: string,
    mempoolBase: string,
    private store: Store,
    rateLimitMs: number,
    options?: ChainRouterOptions,
  ) {
    this.providers = [
      new EsploraProvider(esploraBase, store),
      new MempoolProvider(mempoolBase, store),
    ];
    this.sleepOnRateLimit = options?.sleepOnRateLimit ?? true;
    this.backoff = options?.backoff ?? {
      rateLimitMs,
      apiThresholdBaseSec: 300,
      apiThresholdMaxSec: 3600,
    };
    this.primaryProvider = options?.primaryProvider ?? "esplora";
  }

  private providerId(name: string): ChainApiProviderId {
    return name === "esplora" ? "esplora" : "mempool";
  }

  /** Alternate pick: opposite of last used; cold start uses primaryProvider. */
  private startIndex(lastProviderUsed: string | null | undefined): number {
    if (lastProviderUsed === "esplora") return 1;
    if (lastProviderUsed === "mempool") return 0;
    return this.primaryProvider === "mempool" ? 1 : 0;
  }

  private async waitForRateLimit(): Promise<void> {
    const state = await this.store.getSchedulerState();
    const nextAtIso = state?.nextProviderCallAt ?? null;
    const nextAt = nextAtIso ? new Date(nextAtIso).getTime() : 0;
    const wait = Math.max(0, nextAt - Date.now());
    if (wait <= 0) return;
    if (!this.sleepOnRateLimit) {
      throw new RateLimitNotReadyError(
        nextAtIso ?? new Date(Date.now() + wait).toISOString(),
        "pacing",
      );
    }
    await new Promise((r) => setTimeout(r, wait));
  }

  private orderedProviders(
    state: Awaited<ReturnType<Store["getSchedulerState"]>>,
  ): ChainProvider[] {
    const available: ChainProvider[] = [];
    for (const provider of this.providers) {
      const id = this.providerId(provider.name);
      if (!this.store.isProviderInBackoff(state, id)) {
        available.push(provider);
      }
    }
    if (available.length === 0) return [];
    if (available.length === 1) return available;

    const start = this.startIndex(state?.lastProviderUsed);
    const order: ChainProvider[] = [];
    for (let offset = 0; offset < this.providers.length; offset++) {
      const provider = this.providers[(start + offset) % this.providers.length]!;
      if (available.includes(provider)) {
        order.push(provider);
      }
    }
    return order;
  }

  private async markCalled(providerName: string, success: boolean) {
    const next = new Date(Date.now() + this.backoff.rateLimitMs).toISOString();
    await this.store.updateSchedulerState({
      nextProviderCallAt: next,
      lastProviderUsed: providerName,
      rateLimitMs: this.backoff.rateLimitMs,
      ...(success ? { lastProviderSuccessAt: new Date().toISOString() } : {}),
    });
  }

  private async recordProviderRateLimit(
    state: Awaited<ReturnType<Store["getSchedulerState"]>>,
    providerId: ChainApiProviderId,
    err: unknown,
  ): Promise<void> {
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
  }

  async withProvider<T>(fn: (p: ChainProvider) => Promise<T>): Promise<T> {
    await this.waitForRateLimit();
    let state = await this.store.getSchedulerState();
    const order = this.orderedProviders(state);
    if (order.length === 0) {
      const retryAt =
        (await this.store.earliestProviderRetryAt()) ?? new Date(Date.now() + 60_000).toISOString();
      throw new RateLimitNotReadyError(retryAt, "provider-backoff");
    }

    let lastErr: unknown;
    let lastAttempted: ChainProvider | undefined;

    for (const provider of order) {
      lastAttempted = provider;
      const providerId = this.providerId(provider.name);
      try {
        const result = await fn(provider);
        await this.store.clearProviderStrike(providerId);
        await this.markCalled(provider.name, true);
        return result;
      } catch (err) {
        lastErr = err;
        if (isRateLimitError(err)) {
          await this.recordProviderRateLimit(state, providerId, err);
          state = await this.store.getSchedulerState();
          continue;
        }
        await this.markCalled(provider.name, false);
        throw err;
      }
    }

    if (lastAttempted) {
      await this.markCalled(lastAttempted.name, false);
    }
    throw lastErr;
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
