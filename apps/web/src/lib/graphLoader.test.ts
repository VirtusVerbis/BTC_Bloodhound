import { describe, expect, it } from "vitest";
import {
  computeLoadPercent,
  mergeGraphPages,
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
        completedL2Tokens: 1,
        totalL2Tokens: 2,
        l2TokenProgress: 0,
      }),
    ).toBe(80);
  });
});
