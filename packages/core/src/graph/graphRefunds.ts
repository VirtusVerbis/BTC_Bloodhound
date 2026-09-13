import type { Store } from "@cointrace/db";
import type { GraphEdge, GraphNode } from "./builder.js";
import { mapDbEdgeToGraph } from "./graphEdges.js";

const REFUND_ATTACH_LIMIT = 32;

/** Attach ≥ minEdgeSats payments back to known victims as refund annotations.
 * Collapsed graphs retarget those edges to the victimCluster instead of promoting Victim nodes.
 */
export async function appendVictimRefunds(
  store: Store,
  hacker: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  seen: Set<string>,
  options: { minEdgeSats: number; victimAddresses?: readonly string[] },
): Promise<void> {
  const rows = await store.listVictimRefundsForHacker(hacker, {
    minEdgeSats: options.minEdgeSats,
    limit: REFUND_ATTACH_LIMIT,
    victimAddresses: options.victimAddresses,
  });
  if (rows.length === 0) return;

  const existingIds = new Set(edges.map((e) => e.id));
  const cluster = nodes.find((n) => n.type === "victimCluster");
  if (!cluster) {
    const promote = [...new Set(rows.map((r) => r.toAddress).filter((id) => !seen.has(id)))];
    for (const id of promote) {
      nodes.push({
        id,
        type: "victim",
        label: "Victim",
        role: "victim",
        address: id,
      });
      seen.add(id);
    }
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const row of rows) {
    const mapped = mapDbEdgeToGraph(row.fromAddress, row.toAddress, row);
    mapped.edgeKind = "victim_refund";
    if (cluster) {
      mapped.target = cluster.id;
      mapped.id = `${mapped.source}->${cluster.id}:${mapped.txid}`;
    }
    if (existingIds.has(mapped.id)) continue;
    if (!nodeIds.has(mapped.target)) continue;
    edges.push(mapped);
    existingIds.add(mapped.id);
  }
}
