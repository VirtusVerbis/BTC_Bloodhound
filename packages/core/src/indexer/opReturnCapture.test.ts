import { describe, expect, it, vi } from "vitest";
import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { createChainCallBudget } from "./chainCallBudget.js";
import { captureOpReturnForTx } from "./opReturnCapture.js";

describe("captureOpReturnForTx", () => {
  it("skips getTx when budget exhausted", async () => {
    const upsertTransaction = vi.fn();
    const store = {
      getTransaction: vi.fn().mockResolvedValue(null),
      upsertTransaction,
    } as unknown as Store;

    const getTx = vi.fn();
    const router = {
      withProvider: vi.fn(async (fn: (p: { getTx: typeof getTx }) => Promise<unknown>) =>
        fn({ getTx }),
      ),
    } as unknown as ChainRouter;

    const budget = createChainCallBudget(1);
    budget.consume();

    const result = await captureOpReturnForTx(store, router, "tx1", {
      allowGetTx: true,
      budget,
    });

    expect(getTx).not.toHaveBeenCalled();
    expect(upsertTransaction).not.toHaveBeenCalled();
    expect(result.captured).toBe(false);
  });

  it("stores empty string when tx has no readable OP_RETURN", async () => {
    const store = {
      getTransaction: vi.fn().mockResolvedValue(null),
      upsertTransaction: vi.fn(),
    } as unknown as Store;

    const router = {
      withProvider: vi.fn(),
    } as unknown as ChainRouter;

    await captureOpReturnForTx(store, router, "tx1", {
      allowGetTx: false,
      tx: {
        txid: "tx1",
        vin: [],
        vout: [{ scriptpubkey_address: "bc1qtest", value: 1000 }],
      },
    });

    expect(store.upsertTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ txid: "tx1", opReturnDisplay: "" }),
    );
  });
});
