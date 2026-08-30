import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@cointrace/core";
import { RECONNECT_OP_TIMEOUT_MS, reconnectRemoteProductionStore } from "./remotePlatform.js";

const openRemoteProductionStoreMock = vi.fn();

vi.mock("./remotePlatform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remotePlatform.js")>();
  return {
    ...actual,
    openRemoteProductionStore: (...args: unknown[]) => openRemoteProductionStoreMock(...args),
  };
});

describe("reconnectRemoteProductionStore timeout", () => {
  beforeEach(() => {
    openRemoteProductionStoreMock.mockReset();
    vi.useRealTimers();
  });

  it("times out when dispose hangs", async () => {
    vi.useFakeTimers();
    const config = { maxQueueDepth: 360, d1BatchSize: 8 } as AppConfig;
    const hangingDispose = new Promise<void>(() => {});
    const current = {
      store: {} as never,
      dispose: () => hangingDispose,
    };

    const promise = reconnectRemoteProductionStore(config, current);
    const expectation = expect(promise).rejects.toThrow("dispose remote D1 proxy timed out");
    await vi.advanceTimersByTimeAsync(RECONNECT_OP_TIMEOUT_MS + 1);
    await expectation;
    vi.useRealTimers();
  });
});
