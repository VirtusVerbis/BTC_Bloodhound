import type { Store } from "@cointrace/db";
import { truncateOpReturnGraphLabel } from "../chain/opReturn.js";
import type { GraphNode } from "./builder.js";

export async function enrichNodesWithOpReturn(store: Store, nodes: GraphNode[]): Promise<void> {
  for (const node of nodes) {
    if (!node.address) continue;
    if (node.type === "victim" || node.type === "victimCluster") continue;
    const resolved = await store.resolveOpReturnForAddress(node.address);
    if (!resolved.opReturn) continue;
    node.opReturn = resolved.opReturn;
    node.opReturnLabel = truncateOpReturnGraphLabel(resolved.opReturn);
  }
}
