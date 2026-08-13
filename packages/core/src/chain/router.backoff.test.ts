import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store } from "@cointrace/db";
import { ChainRouter } from "./router.js";
import { RateLimitHttpError } from "./esplora.js";

const backoff = {
  rateLimitMs: 0,
  apiThresholdBaseSec: 300,
  apiThresholdMaxSec: 3600,
};

type SchedulerState = Awaited<ReturnType<Store["getSchedulerState"]>>;

function makeMockStore(initial: Partial<NonNullable<SchedulerState>> = {}) {
  let state: NonNullable<SchedulerState> = {
    id: 1,
    nextProviderCallAt: null,
    lastProviderUsed: null,
    lastProviderSuccessAt: null,
    lastApiThresholdAt: null,
    apiThresholdCount: 0,
    lastEsploraThresholdAt: null,
    lastMempoolThresholdAt: null,
    esploraThresholdCount: 0,
    mempoolThresholdCount: 0,
    esploraStrikeCount: 0,
    mempoolStrikeCount: 0,
    esploraRetryAfterAt: null,
    mempoolRetryAfterAt: null,
    queueSchedulingPaused: 0,
    btcUsdPrice: null,
    btcUsdPriceAt: null,
    btcUsdRefreshAttemptAt: null,
    backfillHealAuditIndex: 0,
    hackerPollIndex: 0,
    tickLeaseHolder: null,
    tickLeaseUntil: null,
    ...initial,
  };

  const store = {
    getSchedulerState: vi.fn(async () => state),
    updateSchedulerState: vi.fn(async (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
    }),
    isProviderInBackoff: vi.fn((_s: SchedulerState, provider: "esplora" | "mempool") => {
      const retryAt = provider === "esplora" ? state.esploraRetryAfterAt : state.mempoolRetryAfterAt;
      if (!retryAt) return false;
      return new Date(retryAt).getTime() > Date.now();
    }),
    getProviderStrikeCount: vi.fn((_s: SchedulerState, provider: "esplora" | "mempool") =>
      provider === "esplora" ? state.esploraStrikeCount : state.mempoolStrikeCount,
    ),
    recordApiThreshold: vi.fn(
      async (provider: "esplora" | "mempool", opts: { retryAfterAt: string; strikeCount: number }) => {
        if (provider === "esplora") {
          state.esploraRetryAfterAt = opts.retryAfterAt;
          state.esploraStrikeCount = opts.strikeCount;
        } else {
          state.mempoolRetryAfterAt = opts.retryAfterAt;
          state.mempoolStrikeCount = opts.strikeCount;
        }
      },
    ),
    clearProviderStrike: vi.fn(async (provider: "esplora" | "mempool") => {
      if (provider === "esplora") {
        state.esploraStrikeCount = 0;
        state.esploraRetryAfterAt = null;
      } else {
        state.mempoolStrikeCount = 0;
        state.mempoolRetryAfterAt = null;
      }
    }),
    earliestProviderRetryAt: vi.fn(async () => {
      const candidates = [state.esploraRetryAfterAt, state.mempoolRetryAfterAt].filter(Boolean) as string[];
      const future = candidates.filter((iso) => new Date(iso).getTime() > Date.now());
      if (future.length === 0) return null;
      return future.reduce((a, b) => (a < b ? a : b));
    }),
  } as unknown as Store;

  return { store, getState: () => state };
}

describe("ChainRouter per-provider backoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips a provider in backoff and uses the alternate", async () => {
    const future = new Date(Date.now() + 600_000).toISOString();
    const { store } = makeMockStore({ esploraRetryAfterAt: future, esploraStrikeCount: 1 });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ txid: "abc", vin: [], vout: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const router = new ChainRouter(
      "https://blockstream.info/api",
      "https://mempool.space/api",
      store,
      0,
      { backoff },
    );
    await router.withProvider((p) => p.getTx("abc"));

    const state = await store.getSchedulerState();
    expect(state?.lastProviderUsed).toBe("mempool");
    expect(fetchMock.mock.calls[0]![0]).toContain("mempool.space");
  });

  it("throws RateLimitNotReadyError when both providers are in backoff", async () => {
    const future = new Date(Date.now() + 600_000).toISOString();
    const { store } = makeMockStore({
      esploraRetryAfterAt: future,
      mempoolRetryAfterAt: future,
    });

    const router = new ChainRouter(
      "https://blockstream.info/api",
      "https://mempool.space/api",
      store,
      0,
      { backoff },
    );

    await expect(router.withProvider((p) => p.getTx("abc"))).rejects.toMatchObject({
      name: "RateLimitNotReadyError",
      reason: "provider-backoff",
    });
    await expect(router.withProvider((p) => p.getTx("abc"))).rejects.toThrow(
      "All providers in backoff until",
    );
  });

  it("throws RateLimitNotReadyError with pacing reason when sleepOnRateLimit is false", async () => {
    const future = new Date(Date.now() + 8_000).toISOString();
    const { store } = makeMockStore({ nextProviderCallAt: future });

    const router = new ChainRouter(
      "https://blockstream.info/api",
      "https://mempool.space/api",
      store,
      8000,
      { sleepOnRateLimit: false, backoff: { ...backoff, rateLimitMs: 8000 } },
    );

    await expect(router.withProvider((p) => p.getTx("abc"))).rejects.toMatchObject({
      name: "RateLimitNotReadyError",
      reason: "pacing",
      retryAt: future,
    });
    await expect(router.withProvider((p) => p.getTx("abc"))).rejects.toThrow(
      "Provider pacing: next call allowed at",
    );
  });

  it("records exponential backoff on HTTP 429", async () => {
    const { store, getState } = makeMockStore();

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "600" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const router = new ChainRouter(
      "https://blockstream.info/api",
      "https://mempool.space/api",
      store,
      0,
      { backoff },
    );

    await expect(router.withProvider((p) => p.getTx("abc"))).rejects.toBeInstanceOf(
      RateLimitHttpError,
    );

    expect(store.recordApiThreshold).toHaveBeenCalledWith("esplora", {
      strikeCount: 1,
      retryAfterAt: expect.any(String),
    });
    const retryAt = getState().esploraRetryAfterAt!;
    const retryMs = new Date(retryAt).getTime() - Date.now();
    expect(retryMs).toBeGreaterThanOrEqual(599_000);
    expect(retryMs).toBeLessThanOrEqual(601_000);
  });

  it("clears provider strike after a successful call", async () => {
    const { store, getState } = makeMockStore({ esploraStrikeCount: 2 });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ txid: "abc", vin: [], vout: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const router = new ChainRouter(
      "https://blockstream.info/api",
      "https://mempool.space/api",
      store,
      0,
      { backoff },
    );
    await router.withProvider((p) => p.getTx("abc"));

    expect(store.clearProviderStrike).toHaveBeenCalledWith("esplora");
    expect(getState().esploraStrikeCount).toBe(0);
    expect(getState().esploraRetryAfterAt).toBeNull();
  });
});
