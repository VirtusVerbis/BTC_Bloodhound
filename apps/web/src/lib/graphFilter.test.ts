import { describe, expect, it } from "vitest";
import {
  canResumeDownstream,
  canTrimLocally,
  filterGraphByLimits,
  type GraphLoadParams,
} from "./graphFilter";
import type { ApiGraphResponse } from "./graphLoader";

const baseParams: GraphLoadParams = {
  hacker: "hack1",
  minEdgeSats: 1000,
  maxVictims: 100,
  maxDownstream: 10,
  expandVictims: false,
};

function sampleGraph(): ApiGraphResponse {
  return {
    mode: "hacker",
    nodes: [
      { id: "hack1", type: "hacker", label: "H", role: "hacker" },
      { id: "victims:hack1", type: "victimCluster", label: "Victims", role: "victim" },
      { id: "d1", type: "downstream", label: "D1", role: "downstream" },
      { id: "d2", type: "downstream", label: "D2", role: "downstream" },
      { id: "d3", type: "downstream", label: "D3", role: "downstream" },
    ],
    edges: [
      { id: "v->h", source: "victims:hack1", target: "hack1", txid: "", amount: 5000, time: null },
      { id: "h->d1", source: "hack1", target: "d1", txid: "t1", amount: 3000, time: null },
      { id: "h->d2", source: "hack1", target: "d2", txid: "t2", amount: 2000, time: null },
      { id: "h->d3", source: "hack1", target: "d3", txid: "t3", amount: 1000, time: null },
      { id: "d1->d4", source: "d1", target: "d4", txid: "t4", amount: 500, time: null },
    ],
  };
}

describe("canTrimLocally", () => {
  it("allows tightening downstream cap", () => {
    expect(canTrimLocally(baseParams, { ...baseParams, maxDownstream: 2 })).toBe(true);
  });

  it("rejects increasing downstream cap", () => {
    expect(canTrimLocally(baseParams, { ...baseParams, maxDownstream: 20 })).toBe(false);
  });

  it("rejects lowering min sats", () => {
    expect(canTrimLocally(baseParams, { ...baseParams, minEdgeSats: 500 })).toBe(false);
  });
});

describe("canResumeDownstream", () => {
  it("allows max_downstream increase with same other params", () => {
    expect(canResumeDownstream(baseParams, { ...baseParams, maxDownstream: 20 })).toBe(true);
  });

  it("rejects when min sats changes", () => {
    expect(canResumeDownstream(baseParams, { ...baseParams, maxDownstream: 20, minEdgeSats: 2000 })).toBe(
      false,
    );
  });
});

describe("filterGraphByLimits", () => {
  it("keeps top downstream nodes by amount when maxDownstream shrinks", () => {
    const graph = sampleGraph();
    graph.nodes.push({ id: "d4", type: "downstream", label: "D4", role: "downstream" });
    const filtered = filterGraphByLimits(graph, { ...baseParams, maxDownstream: 2 });
    const downstream = filtered.nodes.filter((n) => n.type === "downstream");
    expect(downstream.map((n) => n.id).sort()).toEqual(["d1", "d2"]);
  });

  it("drops edges below min sats threshold", () => {
    const graph = sampleGraph();
    graph.nodes.push({ id: "d4", type: "downstream", label: "D4", role: "downstream" });
    const filtered = filterGraphByLimits(graph, { ...baseParams, minEdgeSats: 2500, maxDownstream: 10 });
    expect(filtered.edges.some((e) => e.id === "h->d2")).toBe(false);
    expect(filtered.edges.some((e) => e.id === "h->d1")).toBe(true);
  });
});
