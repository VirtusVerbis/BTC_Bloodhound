import { describe, expect, it } from "vitest";
import { bundleParallelEdges, mapDbEdgeToGraph, victimReturnEdgeKind } from "./graphEdges.js";

describe("graphEdges", () => {
  it("bundles parallel peel edges", () => {
    const edges = Array.from({ length: 3 }, (_, i) => ({
      id: `a->b:${i}`,
      source: "a",
      target: "b",
      txid: `tx${i}`,
      amount: 1000,
      time: null,
      edgeKind: "default" as const,
    }));
    const bundled = bundleParallelEdges(edges, 2);
    expect(bundled).toHaveLength(1);
    expect(bundled[0]!.edgeKind).toBe("peel_relay");
    expect(bundled[0]!.edgeCount).toBe(3);
    expect(bundled[0]!.totalAmount).toBe(3000);
  });

  it("maps spend_fanout db edge with metadata", () => {
    const edge = mapDbEdgeToGraph("src", "dst", {
      id: 1,
      fromAddress: "src",
      toAddress: "dst",
      txid: "txfan",
      amountSats: 50000,
      blockTime: null,
      hopFromHacker: 2,
      direction: "out_from_hacker",
      edgeKind: "spend_fanout",
      fanoutMetaJson: JSON.stringify({ outputCount: 42, topOutputs: [] }),
    });
    expect(edge.edgeKind).toBe("spend_fanout");
    expect(edge.outputCount).toBe(42);
  });

  it("does not bundle victim_refund edges into a peel", () => {
    const edges = [
      {
        id: "a->v:tx1",
        source: "a",
        target: "v",
        txid: "tx1",
        amount: 200_000,
        time: null,
        edgeKind: "victim_refund" as const,
      },
      {
        id: "a->v:tx2",
        source: "a",
        target: "v",
        txid: "tx2",
        amount: 150_000,
        time: null,
        edgeKind: "victim_refund" as const,
      },
    ];
    const bundled = bundleParallelEdges(edges, 2);
    expect(bundled).toHaveLength(2);
    expect(bundled.every((e) => e.edgeKind === "victim_refund")).toBe(true);
  });

  it("classifies victim returns by amount floor", () => {
    expect(victimReturnEdgeKind(99_999, 100_000)).toBe("victim_dust");
    expect(victimReturnEdgeKind(100_000, 100_000)).toBe("victim_refund");
  });
});
