import { describe, expect, it, vi } from "vitest";
import type { Store } from "@cointrace/db";
import { verifyRemoteProductionStore } from "./remotePlatform.js";

describe("verifyRemoteProductionStore", () => {
  it("passes when scheduler_state row exists", async () => {
    const store = {
      getSchedulerState: vi.fn(async () => ({ id: 1, cronIndexerPaused: 1 })),
    } as unknown as Store;
    await verifyRemoteProductionStore(store);
    expect(store.getSchedulerState).toHaveBeenCalledOnce();
  });

  it("throws when scheduler_state row is missing", async () => {
    const store = {
      getSchedulerState: vi.fn(async () => undefined),
    } as unknown as Store;
    await expect(verifyRemoteProductionStore(store)).rejects.toThrow(/empty\/local/);
  });

  it("throws with schema hint when table is missing", async () => {
    const store = {
      getSchedulerState: vi.fn(async () => {
        throw new Error("no such table: scheduler_state");
      }),
    } as unknown as Store;
    await expect(verifyRemoteProductionStore(store)).rejects.toThrow(/schema mismatch/);
  });
});
