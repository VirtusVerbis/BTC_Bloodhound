import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMempoolBtcUsd, mempoolPricesUrl } from "./mempoolPrices.js";

describe("mempoolPricesUrl", () => {
  it("builds prices URL from mempool base", () => {
    expect(mempoolPricesUrl("https://mempool.space/api")).toBe("https://mempool.space/api/v1/prices");
    expect(mempoolPricesUrl("https://mempool.space/api/")).toBe("https://mempool.space/api/v1/prices");
  });
});

describe("fetchMempoolBtcUsd", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses USD and timestamp from response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ time: 1786091409, USD: 64407 }),
      }),
    );

    const result = await fetchMempoolBtcUsd("https://mempool.space/api");
    expect(result.usd).toBe(64407);
    expect(result.at).toBe(new Date(1786091409 * 1000).toISOString());
    expect(fetch).toHaveBeenCalledWith("https://mempool.space/api/v1/prices", expect.any(Object));
  });

  it("throws when USD is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ time: 1786091409 }),
      }),
    );

    await expect(fetchMempoolBtcUsd("https://mempool.space/api")).rejects.toThrow(/valid USD/);
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(fetchMempoolBtcUsd("https://mempool.space/api")).rejects.toThrow(/503/);
  });
});
