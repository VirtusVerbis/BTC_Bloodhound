import { satsToBtc } from "./api";
import type { ApiGraphEdge } from "./graphLoader";

export const REFUND_EDGE_COLOR = "#3dcfef";
export const PEEL_EDGE_COLOR = "#4caf50";
export const FANOUT_EDGE_COLOR = "#ff00ff";
export const DEFAULT_EDGE_COLOR = "#f7931a";

export const DEFAULT_SOURCE_HANDLE = "source";
export const DEFAULT_TARGET_HANDLE = "target";
export const REFUND_SOURCE_HANDLE = "refund-source";
export const REFUND_TARGET_HANDLE = "refund-target";

export function isVictimRefundEdge(e: Pick<ApiGraphEdge, "edgeKind">): boolean {
  return e.edgeKind === "victim_refund";
}

export function graphEdgeColor(e: Pick<ApiGraphEdge, "edgeKind">): string {
  if (e.edgeKind === "peel_relay") return PEEL_EDGE_COLOR;
  if (e.edgeKind === "spend_fanout") return FANOUT_EDGE_COLOR;
  if (e.edgeKind === "victim_refund") return REFUND_EDGE_COLOR;
  return DEFAULT_EDGE_COLOR;
}

export function graphEdgeType(e: Pick<ApiGraphEdge, "edgeKind">): "refund" | "smoothstep" {
  return isVictimRefundEdge(e) ? "refund" : "smoothstep";
}

export function graphEdgeHandles(e: Pick<ApiGraphEdge, "edgeKind">): {
  sourceHandle: string;
  targetHandle: string;
} {
  if (isVictimRefundEdge(e)) {
    return { sourceHandle: REFUND_SOURCE_HANDLE, targetHandle: REFUND_TARGET_HANDLE };
  }
  return { sourceHandle: DEFAULT_SOURCE_HANDLE, targetHandle: DEFAULT_TARGET_HANDLE };
}

export function graphEdgeLabel(e: ApiGraphEdge, show: boolean): string | undefined {
  if (!show) return undefined;
  if (e.edgeKind === "peel_relay") return "peel addresses";
  if (e.edgeKind === "spend_fanout") return "input fan out";
  if (e.edgeKind === "victim_refund") {
    return `refund · ${satsToBtc(e.amount)} BTC`;
  }
  if (e.txid) return `${satsToBtc(e.amount)} BTC`;
  if (e.amount > 0) return `${satsToBtc(e.amount)} BTC`;
  return undefined;
}
