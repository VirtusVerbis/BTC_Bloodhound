import type { Edge } from "@cointrace/db";

export type EdgeKind = "default" | "peel_relay" | "spend_fanout" | "victim_dust" | "victim_refund";

export function victimReturnEdgeKind(
  amountSats: number,
  minSats: number,
): "victim_dust" | "victim_refund" {
  return amountSats >= minSats ? "victim_refund" : "victim_dust";
}

export interface MappedGraphEdge {
  id: string;
  source: string;
  target: string;
  txid: string;
  amount: number;
  time: string | null;
  edgeKind?: EdgeKind;
  bundled?: boolean;
  edgeCount?: number;
  txids?: string[];
  totalAmount?: number;
  outputCount?: number;
  topOutputs?: Array<{ address: string; sats: number }>;
}

export function mapDbEdgeToGraph(
  source: string,
  target: string,
  e: Edge,
): MappedGraphEdge {
  const edgeKind = (e.edgeKind as EdgeKind | null) ?? "default";
  const base: MappedGraphEdge = {
    id: `${source}->${target}:${e.txid}`,
    source,
    target,
    txid: e.txid,
    amount: e.amountSats,
    time: e.blockTime,
    edgeKind,
  };

  if (edgeKind === "spend_fanout" && e.fanoutMetaJson) {
    try {
      const meta = JSON.parse(e.fanoutMetaJson) as {
        outputCount?: number;
        topOutputs?: Array<{ address: string; sats: number }>;
      };
      return {
        ...base,
        outputCount: meta.outputCount,
        topOutputs: meta.topOutputs,
      };
    } catch {
      return base;
    }
  }

  return base;
}

function skipParallelBundle(kind: EdgeKind | undefined): boolean {
  return kind === "spend_fanout" || kind === "victim_refund" || kind === "victim_dust";
}

export function bundleParallelEdges(edges: MappedGraphEdge[], minBundle: number): MappedGraphEdge[] {
  const passthrough = edges.filter((e) => skipParallelBundle(e.edgeKind));
  const rest = edges.filter((e) => !skipParallelBundle(e.edgeKind));

  const groups = new Map<string, MappedGraphEdge[]>();
  for (const edge of rest) {
    const key = `${edge.source}|${edge.target}`;
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }

  const bundled: MappedGraphEdge[] = [...passthrough];
  for (const [, group] of groups) {
    if (group.length >= minBundle) {
      const totalAmount = group.reduce((sum, e) => sum + e.amount, 0);
      const txids = group.map((e) => e.txid).slice(0, 5);
      const sample = group[0]!;
      bundled.push({
        id: `${sample.source}->${sample.target}:bundle`,
        source: sample.source,
        target: sample.target,
        txid: sample.txid,
        amount: totalAmount,
        time: sample.time,
        edgeKind: "peel_relay",
        bundled: true,
        edgeCount: group.length,
        txids,
        totalAmount,
      });
    } else {
      bundled.push(...group);
    }
  }

  return bundled;
}
