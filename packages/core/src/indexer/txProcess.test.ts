import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppConfig } from "../config.js";
import type { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { processClassifiedPendingTx } from "./txProcess.js";
import type { PendingTxRuntime } from "./txPage.js";

const { getTransactionMock, processTxForHackTraceMock, captureOpReturnForTxMock } = vi.hoisted(() => ({
  getTransactionMock: vi.fn(),
  processTxForHackTraceMock: vi.fn().mockResolvedValue({ traceComplete: true, captureChainCalls: 0 }),
  captureOpReturnForTxMock: vi.fn().mockResolvedValue({ captured: true, chainCallsUsed: 0 }),
}));

vi.mock("../graph/builder.js", () => ({
  processTxForHackTrace: processTxForHackTraceMock,
}));

vi.mock("./opReturnCapture.js", () => ({
  captureOpReturnForTx: captureOpReturnForTxMock,
}));

import { loadConfig } from "../config.js";

describe("processClassifiedPendingTx", () => {
  const address = "bc1qhackerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const victim = "bc1qvictimxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const hackers = new Set([address]);
  const receiveEntry: PendingTxRuntime = {
    txid: "abc123",
    isSpend: false,
    voutCount: 1,
    outputAddressCount: 1,
  };

  beforeEach(() => {
    getTransactionMock.mockReset();
    processTxForHackTraceMock.mockClear();
    captureOpReturnForTxMock.mockClear();
  });

  it("skips getTransaction when isSpend is false and receive tracing disabled", async () => {
    const config = loadConfig({ TRACE_FLAGGED_HACKER_RECEIVES: "0" });
    const store = { getTransaction: getTransactionMock } as unknown as Store;
    const router = {} as ChainRouter;

    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      0,
      receiveEntry,
      hackers,
      {},
    );

    expect(getTransactionMock).not.toHaveBeenCalled();
    expect(processTxForHackTraceMock).not.toHaveBeenCalled();
    expect(result.chainCallsUsed).toBe(0);
    expect(result.continued).toBe(false);
  });

  it("traces hop-0 receive when traceFlaggedHackerReceives enabled", async () => {
    const config = loadConfig({ TRACE_FLAGGED_HACKER_RECEIVES: "1" });
    const store = {
      getTransaction: getTransactionMock.mockResolvedValue(null),
    } as unknown as Store;
    const router = {} as ChainRouter;
    const pageEntry = {
      txid: "abc123",
      vin: [{ prevout: { scriptpubkey_address: victim, value: 50_000 } }],
      vout: [{ scriptpubkey_address: address, value: 50_000 }],
    };

    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      0,
      { ...receiveEntry, pageEntry },
      hackers,
      {},
    );

    expect(processTxForHackTraceMock).toHaveBeenCalledTimes(1);
    expect(result.chainCallsUsed).toBe(0);
    expect(result.continued).toBe(false);
  });

  it("skips downstream hop receive even when traceFlaggedHackerReceives enabled", async () => {
    const config = loadConfig({ TRACE_FLAGGED_HACKER_RECEIVES: "1" });
    const store = { getTransaction: getTransactionMock } as unknown as Store;
    const router = {} as ChainRouter;

    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      1,
      receiveEntry,
      hackers,
      {},
    );

    expect(processTxForHackTraceMock).not.toHaveBeenCalled();
    expect(result.chainCallsUsed).toBe(0);
  });

  it("patch-if-null captures OP_RETURN from page without getTx", async () => {
    const config = loadConfig({ TRACE_FLAGGED_HACKER_RECEIVES: "0" });
    const store = {
      getTransaction: getTransactionMock.mockResolvedValue({
        txid: "spend1",
        opReturnDisplay: null,
      }),
    } as unknown as Store;
    const router = {} as ChainRouter;
    const pageEntry = {
      txid: "spend1",
      vin: [{ prevout: { scriptpubkey_address: address, value: 50_000 } }],
      vout: [
        { scriptpubkey_address: victim, value: 49_000 },
        {
          scriptpubkey_type: "op_return",
          scriptpubkey_asm: "OP_RETURN 48656c6c6f",
          value: 0,
        },
      ],
    };
    const spendEntry: PendingTxRuntime = {
      txid: "spend1",
      isSpend: true,
      voutCount: 2,
      outputAddressCount: 1,
      pageEntry,
    };

    await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      0,
      spendEntry,
      hackers,
      {},
    );

    expect(captureOpReturnForTxMock).toHaveBeenCalledWith(
      store,
      router,
      "spend1",
      expect.objectContaining({ allowGetTx: false }),
    );
    expect(processTxForHackTraceMock).not.toHaveBeenCalled();
  });
});
