import { describe, expect, it } from "vitest";
import {
  clampGraphNodeCount,
  clampMinEdgeSats,
  commitGraphNodeDraft,
  commitMinAmountDraft,
  DEFAULT_MAX_GRAPH_NODE_CAP,
  DEFAULT_MAX_VICTIM_NODES,
  DEFAULT_MIN_EDGE_SATS,
  graphNodeInputMaxLength,
  MAX_SATS_SUPPLY,
} from "./graphInputLimits";

describe("clampGraphNodeCount", () => {
  it("clamps to 1..maxCap", () => {
    expect(clampGraphNodeCount(0)).toBe(1);
    expect(clampGraphNodeCount(100)).toBe(100);
    expect(clampGraphNodeCount(999999)).toBe(DEFAULT_MAX_GRAPH_NODE_CAP);
    expect(clampGraphNodeCount(5000, 10000)).toBe(5000);
    expect(clampGraphNodeCount(50000, 10000)).toBe(10000);
  });
});

describe("graphNodeInputMaxLength", () => {
  it("matches digit count of cap", () => {
    expect(graphNodeInputMaxLength(1000)).toBe(4);
    expect(graphNodeInputMaxLength(10000)).toBe(5);
  });
});

describe("clampMinEdgeSats", () => {
  it("clamps to 0..max supply", () => {
    expect(clampMinEdgeSats(-1)).toBe(0);
    expect(clampMinEdgeSats(MAX_SATS_SUPPLY + 1)).toBe(MAX_SATS_SUPPLY);
  });
});

describe("commitGraphNodeDraft", () => {
  it("uses default when blank", () => {
    let committed = 0;
    let draft = "";
    commitGraphNodeDraft("", DEFAULT_MAX_VICTIM_NODES, (n) => (committed = n), (s) => (draft = s));
    expect(committed).toBe(DEFAULT_MAX_VICTIM_NODES);
    expect(draft).toBe(String(DEFAULT_MAX_VICTIM_NODES));
  });

  it("clamps parsed value to maxCap", () => {
    let committed = 0;
    let draft = "";
    commitGraphNodeDraft("5000", DEFAULT_MAX_VICTIM_NODES, (n) => (committed = n), (s) => (draft = s), 10000);
    expect(committed).toBe(5000);
    expect(draft).toBe("5000");
  });

  it("clamps parsed value above maxCap", () => {
    let committed = 0;
    let draft = "";
    commitGraphNodeDraft("50000", DEFAULT_MAX_VICTIM_NODES, (n) => (committed = n), (s) => (draft = s), 10000);
    expect(committed).toBe(10000);
    expect(draft).toBe("10000");
  });
});

describe("commitMinAmountDraft", () => {
  it("uses default sats when blank", () => {
    let committed = 0;
    let draft = "";
    commitMinAmountDraft("", "sats", DEFAULT_MIN_EDGE_SATS, (n) => (committed = n), (s) => (draft = s));
    expect(committed).toBe(DEFAULT_MIN_EDGE_SATS);
    expect(draft).toBe(String(DEFAULT_MIN_EDGE_SATS));
  });
});
