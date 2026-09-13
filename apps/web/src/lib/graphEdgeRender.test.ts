import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDGE_COLOR,
  DEFAULT_SOURCE_HANDLE,
  DEFAULT_TARGET_HANDLE,
  PEEL_EDGE_COLOR,
  REFUND_EDGE_COLOR,
  REFUND_SOURCE_HANDLE,
  REFUND_TARGET_HANDLE,
  graphEdgeColor,
  graphEdgeHandles,
  graphEdgeLabel,
  graphEdgeType,
} from "./graphEdgeRender";
import type { ApiGraphEdge } from "./graphLoader";

const refund: ApiGraphEdge = {
  id: "d->v",
  source: "down1",
  target: "victim1",
  txid: "tx_refund",
  amount: 100_000_000,
  time: null,
  edgeKind: "victim_refund",
};

describe("graphEdgeRender", () => {
  it("maps victim_refund to the top-arc handles and cyan refund type", () => {
    expect(graphEdgeType(refund)).toBe("refund");
    expect(graphEdgeColor(refund)).toBe(REFUND_EDGE_COLOR);
    expect(graphEdgeColor(refund)).not.toBe(PEEL_EDGE_COLOR);
    expect(graphEdgeHandles(refund)).toEqual({
      sourceHandle: REFUND_SOURCE_HANDLE,
      targetHandle: REFUND_TARGET_HANDLE,
    });
    expect(graphEdgeLabel(refund, true)).toMatch(/^refund · /);
  });

  it("keeps default orange LR handles for ordinary edges", () => {
    const edge: ApiGraphEdge = {
      id: "h->d",
      source: "hack1",
      target: "down1",
      txid: "tx1",
      amount: 1000,
      time: null,
    };
    expect(graphEdgeType(edge)).toBe("smoothstep");
    expect(graphEdgeColor(edge)).toBe(DEFAULT_EDGE_COLOR);
    expect(graphEdgeHandles(edge)).toEqual({
      sourceHandle: DEFAULT_SOURCE_HANDLE,
      targetHandle: DEFAULT_TARGET_HANDLE,
    });
  });
});
