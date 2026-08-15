import { describe, expect, it } from "vitest";
import { computeLoadPercent, mergeGraphPages } from "./graphLoader";

describe("mergeGraphPages", () => {
  it("dedupes nodes and edges by id", () => {
    const merged = mergeGraphPages([
      {
        nodes: [
          { id: "hack", type: "hacker", label: "H", role: "hacker" },
          { id: "d1", type: "downstream", label: "D", role: "downstream" },
        ],
        edges: [{ id: "e1", source: "hack", target: "d1", txid: "t1", amount: 1, time: null }],
      },
      {
        nodes: [{ id: "d2", type: "downstream", label: "D", role: "downstream" }],
        edges: [{ id: "e2", source: "d1", target: "d2", txid: "t2", amount: 2, time: null }],
      },
    ]);
    expect(merged.nodes).toHaveLength(3);
    expect(merged.edges).toHaveLength(2);
  });
});

describe("computeLoadPercent", () => {
  it("weights L1 at 60% and L2 at 40%", () => {
    expect(
      computeLoadPercent({
        phase: "l1",
        loadedL1: 50,
        totalL1: 100,
        maxDownstream: 100,
        completedL2Tokens: 0,
        totalL2Tokens: 0,
        l2TokenProgress: 0,
      }),
    ).toBe(30);

    expect(
      computeLoadPercent({
        phase: "l2",
        loadedL1: 100,
        totalL1: 100,
        maxDownstream: 100,
        completedL2Tokens: 1,
        totalL2Tokens: 2,
        l2TokenProgress: 0,
      }),
    ).toBe(80);
  });
});
