import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations } from "@cointrace/db";
import { Store } from "@cointrace/db";
import type { ChainRouter } from "../chain/router.js";
import { loadConfig } from "../config.js";
import { processClassifiedPendingTx } from "./txProcess.js";
import { pendingFromPageTxs } from "./pendingPayload.js";

const HACKER = "bc1qhackerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const VICTIM = "bc1qvictimxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("receive deposit indexing", () => {
  it("pendingFromPageTxs → processClassifiedPendingTx writes in_to_hacker edge", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: HACKER,
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });

    const config = loadConfig({ TRACE_FLAGGED_HACKER_RECEIVES: "1" });
    const tx = {
      txid: "deposit-tx-1",
      status: { block_height: 800_000, block_time: 1_700_000_000 },
      vin: [{ prevout: { scriptpubkey_address: VICTIM, value: 25_000 } }],
      vout: [{ scriptpubkey_address: HACKER, value: 25_000 }],
    };
    const pending = pendingFromPageTxs([tx], HACKER);
    const router = { withProvider: vi.fn() } as unknown as ChainRouter;
    const hackers = new Set([HACKER]);

    await processClassifiedPendingTx(
      store,
      router,
      config,
      HACKER,
      0,
      pending[0]!,
      hackers,
      {},
    );

    const edges = (await store.getEdgesToAddress(HACKER)).filter(
      (e) => e.direction === "in_to_hacker",
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromAddress: VICTIM,
      toAddress: HACKER,
      amountSats: 25_000,
      txid: "deposit-tx-1",
    });
    expect((await store.getAddress(HACKER))?.totalReceivedSats).toBe(25_000);
  });
});
