import { describe, expect, it, vi } from "vitest";
import { collectSpenders, processTxForHackTrace } from "./builder.js";
import type { ChainTxDetail } from "../chain/types.js";
import type { ChainRouter } from "../chain/router.js";
import { openDatabase, runMigrations, Store } from "@cointrace/db";

function makeTx(vinAddrs: string[], voutAddrs: string[]): ChainTxDetail {
  return {
    txid: "abc123",
    status: { block_height: 100, block_time: 1_700_000_000 },
    fee: 500,
    vin: vinAddrs.map((addr) => ({
      prevout: { scriptpubkey_address: addr, value: 1000 },
    })),
    vout: voutAddrs.map((addr) => ({
      scriptpubkey_address: addr,
      value: 1000,
    })),
  };
}

describe("collectSpenders", () => {
  const hackers = new Set(["hack1"]);

  it("includes hacker inputs at hop 0", () => {
    const spenders = collectSpenders(["hack1", "other"], hackers);
    expect(spenders).toEqual([{ address: "hack1", hop: 0 }]);
  });

  it("includes explicit spending downstream address", () => {
    const spenders = collectSpenders(["down1"], hackers, {
      spendingAddress: "down1",
      spendingHop: 1,
    });
    expect(spenders).toEqual([{ address: "down1", hop: 1 }]);
  });

  it("does not duplicate when hacker and spendingAddress overlap", () => {
    const spenders = collectSpenders(["hack1"], hackers, {
      spendingAddress: "hack1",
      spendingHop: 0,
    });
    expect(spenders).toHaveLength(1);
  });
});

describe("processTxForHackTrace", () => {
  it("records hop-2 downstream when hop-1 address spends", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    store.upsertAddress({
      address: "down1",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });

    const tx = makeTx(["down1"], ["child2"]);
    const router = {
      withProvider: vi.fn(),
    } as unknown as ChainRouter;

    const hackers = new Set<string>();
    await processTxForHackTrace(store, router, tx.txid, hackers, {
      tx,
      spendingAddress: "down1",
      spendingHop: 1,
    });

    const child = store.getAddress("child2");
    expect(child?.hopFromHacker).toBe(2);
    expect(child?.expandStatus).toBe("pending");
    const edges = store.getEdgesFromAddress("down1");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.toAddress).toBe("child2");
  });

  it("records hop-1 downstream when hacker spends", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });

    const tx = makeTx(["hack1"], ["down1"]);
    const router = { withProvider: vi.fn() } as unknown as ChainRouter;
    const hackers = new Set(["hack1"]);

    await processTxForHackTrace(store, router, tx.txid, hackers, { tx });

    const down = store.getAddress("down1");
    expect(down?.hopFromHacker).toBe(1);
    expect(store.getEdgesFromAddress("hack1")).toHaveLength(1);
  });
});
