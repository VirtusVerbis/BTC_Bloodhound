import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { processClassifiedPendingTx } from "./txProcess.js";
import type { PendingTxRuntime } from "./txPage.js";

const { getTransactionMock } = vi.hoisted(() => ({
  getTransactionMock: vi.fn(),
}));

vi.mock("../graph/builder.js", () => ({
  processTxForHackTrace: vi.fn(),
}));

import { loadConfig } from "../config.js";

describe("processClassifiedPendingTx", () => {
  const config = loadConfig({});
  const address = "bc1qtestaddrxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const hackers = new Set<string>();
  const entry: PendingTxRuntime = {
    txid: "abc123",
    isSpend: false,
    voutCount: 1,
    outputAddressCount: 1,
  };

  beforeEach(() => {
    getTransactionMock.mockReset();
  });

  it("skips getTransaction when isSpend is false", async () => {
    const store = { getTransaction: getTransactionMock } as unknown as Store;
    const router = {} as ChainRouter;

    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      0,
      entry,
      hackers,
      {},
    );

    expect(getTransactionMock).not.toHaveBeenCalled();
    expect(result.chainCallsUsed).toBe(0);
    expect(result.continued).toBe(false);
  });
});
