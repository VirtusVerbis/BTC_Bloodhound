import { describe, expect, it } from "vitest";
import { bundleParallelEdges, mapDbEdgeToGraph } from "./graphEdges.js";

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
});
