import { describe, expect, it } from "vitest";
import {
  clampGraphNodeCount,
  clampMinEdgeSats,
  commitGraphNodeDraft,
  commitMinAmountDraft,
  DEFAULT_MAX_VICTIM_NODES,
  DEFAULT_MIN_EDGE_SATS,
  MAX_GRAPH_NODE_COUNT,
  MAX_SATS_SUPPLY,
} from "./graphInputLimits";

describe("clampGraphNodeCount", () => {
  it("clamps to 1..1000", () => {
    expect(clampGraphNodeCount(0)).toBe(1);
    expect(clampGraphNodeCount(100)).toBe(100);
    expect(clampGraphNodeCount(999999)).toBe(MAX_GRAPH_NODE_COUNT);
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

  it("clamps parsed value", () => {
    let committed = 0;
    let draft = "";
    commitGraphNodeDraft("5000", DEFAULT_MAX_VICTIM_NODES, (n) => (committed = n), (s) => (draft = s));
    expect(committed).toBe(MAX_GRAPH_NODE_COUNT);
    expect(draft).toBe(String(MAX_GRAPH_NODE_COUNT));
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
