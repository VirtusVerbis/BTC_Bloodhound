import { describe, expect, it } from "vitest";
import {
  computeLoadPercent,
  mergeGraphPages,
  omitGraphNodeIds,
  shouldResumeL1,
  shouldReexpandL2,
} from "./graphLoader";

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

describe("omitGraphNodeIds", () => {
  it("drops a node and its incident edges", () => {
    const omitted = omitGraphNodeIds(
      {
        nodes: [
          { id: "hack", type: "hacker", label: "H", role: "hacker" },
          { id: "fanout:d1", type: "fanoutCluster", label: "Fanout", role: "downstream", childCount: 9 },
        ],
        edges: [{ id: "e1", source: "hack", target: "fanout:d1", txid: "", amount: 1, time: null }],
      },
      ["fanout:d1"],
    );
    expect(omitted.nodes.map((n) => n.id)).toEqual(["hack"]);
    expect(omitted.edges).toHaveLength(0);
  });
});

describe("shouldResumeL1", () => {
  it("resumes when capped with cursor and higher max downstream", () => {
    expect(
      shouldResumeL1({ loadedL1: 1000, nextCursor: "abc", done: true, loadId: "id" }, 5000),
    ).toBe(true);
  });

  it("does not resume when done with no cursor", () => {
    expect(shouldResumeL1({ loadedL1: 1000, nextCursor: null, done: true }, 5000)).toBe(false);
  });
});

describe("shouldReexpandL2", () => {
  it("re-expands completed sessions when max downstream increases", () => {
    expect(
      shouldReexpandL2({ l2Token: "t", loadedL2: 10, nextCursor: null, done: true }, 1000, 5000),
    ).toBe(true);
  });

  it("does not re-expand when max downstream unchanged", () => {
    expect(
      shouldReexpandL2({ l2Token: "t", loadedL2: 10, nextCursor: null, done: true }, 1000, 1000),
    ).toBe(false);
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
        completedL2Tokens: 0,
        totalL2Tokens: 1,
        l2TokenProgress: 8 / 16,
      }),
    ).toBe(80);
  });

  it("advances L2 percent with parent progress instead of a 80% plateau", () => {
    expect(
      computeLoadPercent({
        phase: "l2",
        loadedL1: 16,
        totalL1: 16,
        maxDownstream: 100,
        completedL2Tokens: 0,
        totalL2Tokens: 1,
        l2TokenProgress: 4 / 16,
      }),
    ).toBe(70);
  });
});
