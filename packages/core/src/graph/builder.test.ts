import { describe, expect, it, vi } from "vitest";
import {
  applyHackTraceEdgesChunk,
  buildGraph,
  buildVictimGraph,
  collectSpenders,
  computeHackTraceEdges,
  processTxForHackTrace,
} from "./builder.js";
import * as builderModule from "./builder.js";
import { buildGraphL1Page, buildGraphL2Page } from "./graphPaged.js";
import type { ChainTxDetail } from "../chain/types.js";
import type { ChainRouter } from "../chain/router.js";
import { openDatabase, runMigrations, Store } from "@cointrace/db";

function makeTx(
  vin: Array<{ address: string; value: number; coinbase?: boolean }>,
  vout: Array<{ address: string; value: number }>,
  txid = "abc123",
): ChainTxDetail {
  return {
    txid,
    status: { block_height: 100, block_time: 1_700_000_000 },
    fee: 500,
    vin: vin.map((input) =>
      input.coinbase
        ? { is_coinbase: true }
        : {
            prevout: { scriptpubkey_address: input.address, value: input.value },
          },
    ),
    vout: vout.map((output) => ({
      scriptpubkey_address: output.address,
      value: output.value,
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

describe("computeHackTraceEdges", () => {
  const hackers = new Set(["hack1", "hack2"]);

  it("attributes each victim input by prevout value, not full output", () => {
    const tx = makeTx(
      [
        { address: "v1", value: 10_000 },
        { address: "v2", value: 20_000 },
        { address: "v3", value: 30_000 },
      ],
      [{ address: "hack1", value: 60_000 }],
    );

    const { inToHacker } = computeHackTraceEdges(tx, hackers);
    expect(inToHacker).toHaveLength(3);
    expect(inToHacker).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromAddress: "v1", toAddress: "hack1", amountSats: 10_000 }),
        expect.objectContaining({ fromAddress: "v2", toAddress: "hack1", amountSats: 20_000 }),
        expect.objectContaining({ fromAddress: "v3", toAddress: "hack1", amountSats: 30_000 }),
      ]),
    );
  });

  it("aggregates same victim UTXOs in one tx", () => {
    const tx = makeTx(
      [
        { address: "v1", value: 10_000 },
        { address: "v1", value: 15_000 },
      ],
      [{ address: "hack1", value: 25_000 }],
    );

    const { inToHacker, victimAddresses } = computeHackTraceEdges(tx, hackers);
    expect(victimAddresses).toEqual(["v1"]);
    expect(inToHacker).toEqual([
      expect.objectContaining({ fromAddress: "v1", toAddress: "hack1", amountSats: 25_000 }),
    ]);
  });

  it("does not create in_to_hacker when hacker sweeps to hacker", () => {
    const tx = makeTx([{ address: "hack1", value: 100_000 }], [{ address: "hack2", value: 99_000 }]);

    const { inToHacker, outFromHacker } = computeHackTraceEdges(tx, hackers);
    expect(inToHacker).toHaveLength(0);
    expect(outFromHacker).toEqual([
      expect.objectContaining({
        fromAddress: "hack1",
        toAddress: "hack2",
        amountSats: 99_000,
        direction: "out_from_hacker",
      }),
    ]);
  });

  it("splits victim input proportionally across multiple hacker outputs", () => {
    const tx = makeTx([{ address: "v1", value: 100_000 }], [
      { address: "hack1", value: 40_000 },
      { address: "hack2", value: 60_000 },
    ]);

    const { inToHacker } = computeHackTraceEdges(tx, hackers);
    expect(inToHacker).toHaveLength(2);
    expect(inToHacker).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromAddress: "v1", toAddress: "hack1", amountSats: 40_000 }),
        expect.objectContaining({ fromAddress: "v1", toAddress: "hack2", amountSats: 60_000 }),
      ]),
    );
  });

  it("does not multiply output amount across many victim inputs", () => {
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      address: `v${i}`,
      value: 5_000,
    }));
    const tx = makeTx(inputs, [{ address: "hack1", value: 100_000 }]);

    const { inToHacker } = computeHackTraceEdges(tx, hackers);
    expect(inToHacker).toHaveLength(20);
    expect(inToHacker.reduce((sum, edge) => sum + edge.amountSats, 0)).toBe(100_000);
  });
});

describe("processTxForHackTrace", () => {
  it("records hop-2 downstream when hop-1 address spends", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "down1",
      role: "downstream",
      hopFromHacker: 1,
      expandStatus: "expanded",
    });

    const tx = makeTx([{ address: "down1", value: 1000 }], [{ address: "child2", value: 1000 }]);
    const router = {
      withProvider: vi.fn(),
    } as unknown as ChainRouter;

    const hackers = new Set<string>();
    await processTxForHackTrace(store, router, tx.txid, hackers, {
      tx,
      spendingAddress: "down1",
      spendingHop: 1,
    });

    const child = await store.getAddress("child2");
    expect(child?.hopFromHacker).toBe(2);
    expect(child?.expandStatus).toBe("pending");
    const edges = await store.getEdgesFromAddress("down1");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.toAddress).toBe("child2");
  });

  it("records hop-1 downstream when hacker spends", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });

    const tx = makeTx([{ address: "hack1", value: 1000 }], [{ address: "down1", value: 1000 }]);
    const router = { withProvider: vi.fn() } as unknown as ChainRouter;
    const hackers = new Set(["hack1"]);

    await processTxForHackTrace(store, router, tx.txid, hackers, { tx });

    const down = await store.getAddress("down1");
    expect(down?.hopFromHacker).toBe(1);
    expect(await store.getEdgesFromAddress("hack1")).toHaveLength(1);
    expect(await store.getEdgesToAddress("hack1")).toHaveLength(0);
  });

  it("stores per-input victim amounts for multi-input deposits", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });

    const tx = makeTx(
      [
        { address: "v1", value: 10_000 },
        { address: "v2", value: 20_000 },
        { address: "v3", value: 30_000 },
      ],
      [{ address: "hack1", value: 60_000 }],
    );
    const router = { withProvider: vi.fn() } as unknown as ChainRouter;
    const hackers = new Set(["hack1"]);

    await processTxForHackTrace(store, router, tx.txid, hackers, { tx });

    expect((await store.getAddress("hack1"))?.totalReceivedSats).toBe(60_000);
    const inEdges = (await store.getEdgesToAddress("hack1")).filter((e) => e.direction === "in_to_hacker");
    expect(inEdges).toHaveLength(3);
    expect(inEdges.reduce((sum, e) => sum + e.amountSats, 0)).toBe(60_000);
  });

  it("skips computeHackTraceEdges when traceEdgesFlat cache is provided", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
    });
    const tx = makeTx([{ address: "hack1", value: 1000 }], [{ address: "down1", value: 1000 }]);
    const hackers = new Set(["hack1"]);
    const computed = computeHackTraceEdges(tx, hackers, {
      spendingAddress: "hack1",
      spendingHop: 0,
    });
    const flat = [...computed.inToHacker, ...computed.outFromHacker];
    const router = { withProvider: vi.fn() } as unknown as ChainRouter;
    const spy = vi.spyOn(builderModule, "computeHackTraceEdges");

    await processTxForHackTrace(store, router, tx.txid, hackers, {
      tx,
      spendingAddress: "hack1",
      spendingHop: 0,
      traceEdgeIndex: 0,
      traceEdgeTotal: flat.length,
      traceEdgesFlat: flat,
      maxEdgesPerJob: 1,
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("victim search graph filters", () => {
  async function seedHackerWithRankedVictims() {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      label: "Collector 1",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });

    // Two large victims occupy the top ranks; target is small / low-rank.
    await store.upsertEdge({
      fromAddress: "big1",
      toAddress: "hack1",
      txid: "tx-big1",
      amountSats: 5_000_000,
      direction: "in_to_hacker",
      blockTime: "2026-01-01T00:00:00.000Z",
    });
    await store.upsertEdge({
      fromAddress: "big2",
      toAddress: "hack1",
      txid: "tx-big2",
      amountSats: 4_000_000,
      direction: "in_to_hacker",
      blockTime: "2026-01-02T00:00:00.000Z",
    });
    await store.upsertEdge({
      fromAddress: "tiny-victim",
      toAddress: "hack1",
      txid: "tx-tiny",
      amountSats: 100,
      direction: "in_to_hacker",
      blockTime: "2026-01-03T00:00:00.000Z",
    });
    return store;
  }

  it("buildGraph victimFilter draws low-rank / below-min victim despite maxVictims and minEdgeSats", async () => {
    const store = await seedHackerWithRankedVictims();

    const withoutFilter = await buildGraph(store, "hack1", {
      expandVictims: true,
      maxVictims: 2,
      minEdgeSats: 1000,
    });
    expect(withoutFilter.nodes.some((n) => n.id === "tiny-victim")).toBe(false);

    const filtered = await buildGraph(store, "hack1", {
      expandVictims: false,
      maxVictims: 2,
      minEdgeSats: 1000,
      victimFilter: "tiny-victim",
    });
    expect(filtered.mode).toBe("victim-filtered");
    const victimNode = filtered.nodes.find((n) => n.id === "tiny-victim");
    expect(victimNode).toMatchObject({
      type: "victim",
      address: "tiny-victim",
      incomingSats: 100,
    });
    expect(filtered.edges.some((e) => e.source === "tiny-victim" && e.target === "hack1")).toBe(true);
  });

  it("buildVictimGraph finds below-min victim when minEdgeSats is not applied", async () => {
    const store = await seedHackerWithRankedVictims();
    await store.upsertAddress({
      address: "hack2",
      role: "hacker",
      label: "Collector 2",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    await store.upsertEdge({
      fromAddress: "tiny-victim",
      toAddress: "hack2",
      txid: "tx-tiny-2",
      amountSats: 50,
      direction: "in_to_hacker",
    });

    const withMin = await buildVictimGraph(store, "tiny-victim", { minEdgeSats: 1000 });
    expect(withMin.nodes).toHaveLength(0);

    const withoutMin = await buildVictimGraph(store, "tiny-victim");
    expect(withoutMin.mode).toBe("victim-centric");
    expect(withoutMin.nodes.some((n) => n.id === "tiny-victim")).toBe(true);
    expect(withoutMin.matchedHackers?.sort()).toEqual(["hack1", "hack2"]);
  });

  it("buildGraph depth=2 includes hop-2 downstream nodes via batched reads", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddressesBatch([
      { address: "hack1", role: "hacker", source: "admin", isFlaggedHacker: true, hopFromHacker: 0 },
      { address: "down1", role: "downstream", source: "derived", hopFromHacker: 1 },
      { address: "down2", role: "downstream", source: "derived", hopFromHacker: 1 },
      { address: "down3", role: "downstream", source: "derived", hopFromHacker: 1 },
      { address: "down4", role: "downstream", source: "derived", hopFromHacker: 1 },
      { address: "down5", role: "downstream", source: "derived", hopFromHacker: 1 },
      { address: "child1", role: "downstream", source: "derived", hopFromHacker: 2 },
      { address: "child2", role: "downstream", source: "derived", hopFromHacker: 2 },
    ]);
    await store.upsertEdgesBatch([
      { fromAddress: "hack1", toAddress: "down1", txid: "tx1", amountSats: 5000, direction: "out_from_hacker" },
      { fromAddress: "hack1", toAddress: "down2", txid: "tx2", amountSats: 4000, direction: "out_from_hacker" },
      { fromAddress: "hack1", toAddress: "down3", txid: "tx3", amountSats: 3000, direction: "out_from_hacker" },
      { fromAddress: "hack1", toAddress: "down4", txid: "tx4", amountSats: 2000, direction: "out_from_hacker" },
      { fromAddress: "hack1", toAddress: "down5", txid: "tx5", amountSats: 1000, direction: "out_from_hacker" },
      { fromAddress: "down1", toAddress: "child1", txid: "tx6", amountSats: 500, direction: "out_from_hacker" },
      { fromAddress: "down2", toAddress: "child2", txid: "tx7", amountSats: 400, direction: "out_from_hacker" },
    ]);

    const graph = await buildGraph(store, "hack1", { depth: 2, minEdgeSats: 100 });
    const downstreamIds = graph.nodes.filter((n) => n.type === "downstream").map((n) => n.id);
    expect(downstreamIds).toEqual(expect.arrayContaining(["down1", "down2", "down3", "down4", "down5", "child1", "child2"]));
    expect(graph.edges.some((e) => e.source === "down1" && e.target === "child1")).toBe(true);
    expect(graph.edges.some((e) => e.source === "down2" && e.target === "child2")).toBe(true);
  });

  it("buildGraph caps level-2 address lookups under heavy fan-out", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    const hop1: string[] = [];
    const hop2: string[] = [];
    const addressRows = [
      { address: "hack1", role: "hacker" as const, source: "admin" as const, isFlaggedHacker: true, hopFromHacker: 0 },
    ];
    const edgeRows: Array<{
      fromAddress: string;
      toAddress: string;
      txid: string;
      amountSats: number;
      direction: "out_from_hacker";
    }> = [];
    for (let i = 0; i < 10; i++) {
      const down = `bc1qdown${String(i).padStart(2, "0")}`;
      hop1.push(down);
      addressRows.push({ address: down, role: "downstream", source: "derived", hopFromHacker: 1 });
      edgeRows.push({
        fromAddress: "hack1",
        toAddress: down,
        txid: `txh${i}`,
        amountSats: 10_000 - i,
        direction: "out_from_hacker",
      });
      for (let j = 0; j < 50; j++) {
        const child = `bc1qchild${String(i).padStart(2, "0")}${String(j).padStart(2, "0")}`;
        hop2.push(child);
        addressRows.push({ address: child, role: "downstream", source: "derived", hopFromHacker: 2 });
        edgeRows.push({
          fromAddress: down,
          toAddress: child,
          txid: `txc${i}${j}`,
          amountSats: 1000 - j,
          direction: "out_from_hacker",
        });
      }
    }
    await store.upsertAddressesBatch(addressRows);
    await store.upsertEdgesBatch(edgeRows);

    const graph = await buildGraph(store, "hack1", { depth: 2, minEdgeSats: 100, maxOutputs: 10 });
    const level2Nodes = graph.nodes.filter((n) => n.type === "downstream" && hop2.includes(n.id));
    expect(level2Nodes.length).toBeGreaterThan(0);
    expect(level2Nodes.length).toBeLessThan(hop2.length);
    expect(graph.nodes.some((n) => n.id === "hack1")).toBe(true);
  });
});

describe("buildGraphL1Page pagination", () => {
  it("paginates L1 downstream and emits l2Token", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    const downs = ["down1", "down2", "down3"];
    await store.upsertAddressesBatch(
      downs.map((address) => ({ address, role: "downstream", source: "derived", hopFromHacker: 1 })),
    );
    await store.upsertEdgesBatch(
      downs.map((address, i) => ({
        fromAddress: "hack1",
        toAddress: address,
        txid: `tx${i}`,
        amountSats: 3000 - i * 1000,
        direction: "out_from_hacker" as const,
      })),
    );

    const page1 = await buildGraphL1Page(store, "hack1", {
      limit: 2,
      maxDownstream: 100,
      minEdgeSats: 0,
      maxGraphDepth: 2,
      loadId: "test-load-id",
    });
    expect(page1.page.totalL1).toBe(3);
    expect(page1.page.loadedL1).toBe(2);
    expect(page1.page.done).toBe(false);
    expect(page1.page.nextCursor).toBeTruthy();
    expect(page1.l2Token).toBeTruthy();
    expect(page1.nodes.some((n) => n.id === "hack1")).toBe(true);

    const page2 = await buildGraphL1Page(store, "hack1", {
      limit: 2,
      cursor: page1.page.nextCursor,
      loadedL1: page1.page.loadedL1,
      maxDownstream: 100,
      minEdgeSats: 0,
      maxGraphDepth: 2,
    });
    expect(page2.page.done).toBe(true);
    expect(page2.nodes.some((n) => n.id === "hack1")).toBe(false);
    expect(page2.nodes.filter((n) => n.type === "downstream")).toHaveLength(1);
  });

  it("buildGraphL2Page returns hop-2 children for l2 token parents", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddressesBatch([
      { address: "hack1", role: "hacker", isFlaggedHacker: true, hopFromHacker: 0 },
      { address: "down1", role: "downstream", source: "derived", hopFromHacker: 1 },
      { address: "child1", role: "downstream", source: "derived", hopFromHacker: 2 },
    ]);
    await store.upsertEdgesBatch([
      {
        fromAddress: "hack1",
        toAddress: "down1",
        txid: "tx1",
        amountSats: 5000,
        direction: "out_from_hacker",
      },
      {
        fromAddress: "down1",
        toAddress: "child1",
        txid: "tx2",
        amountSats: 4000,
        direction: "out_from_hacker",
      },
    ]);

    const l1 = await buildGraphL1Page(store, "hack1", {
      limit: 10,
      maxDownstream: 100,
      minEdgeSats: 0,
      maxGraphDepth: 2,
    });
    expect(l1.l2Token).toBeTruthy();

    const l2 = await buildGraphL2Page(store, l1.l2Token!, { limit: 50 });
    expect(l2.nodes.some((n) => n.id === "child1")).toBe(true);
    expect(l2.edges.some((e) => e.source === "down1" && e.target === "child1")).toBe(true);
  });
});

describe("applyHackTraceEdgesChunk graph activity", () => {
  it("records recent hacker activity when a new victim is indexed", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });

    const tx = makeTx([{ address: "v1", value: 10_000 }], [{ address: "hack1", value: 10_000 }]);
    const computed = computeHackTraceEdges(tx, new Set(["hack1"]));
    await applyHackTraceEdgesChunk(store, { txid: tx.txid, blockTime: "2026-01-01T00:00:00.000Z" }, computed);
    await store.flushRecentHackerActivity(5);

    const recent = await store.getRecentHackersActivity();
    expect(recent).toEqual([
      {
        address: "hack1",
        at: "2026-01-01T00:00:00.000Z",
        victims: 1,
        downstream: 0,
      },
    ]);
  });

  it("records activity when victim already exists but edge is new", async () => {
    const { sqlite, db } = openDatabase(":memory:");
    runMigrations(sqlite);
    const store = new Store(db);
    await store.upsertAddress({
      address: "hack1",
      role: "hacker",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    await store.upsertAddress({ address: "v1", role: "victim", source: "derived" });

    const tx = makeTx([{ address: "v1", value: 10_000 }], [{ address: "hack1", value: 10_000 }]);
    const computed = computeHackTraceEdges(tx, new Set(["hack1"]));
    await applyHackTraceEdgesChunk(store, { txid: tx.txid, blockTime: "2026-02-01T00:00:00.000Z" }, computed);
    await store.flushRecentHackerActivity(5);

    const recent = await store.getRecentHackersActivity();
    expect(recent).toEqual([
      {
        address: "hack1",
        at: "2026-02-01T00:00:00.000Z",
        victims: 1,
        downstream: 0,
      },
    ]);
  });
});
