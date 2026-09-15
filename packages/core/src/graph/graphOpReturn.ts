import type { Store } from "@cointrace/db";
import { truncateOpReturnGraphLabel } from "../chain/opReturn.js";
import type { GraphNode } from "./builder.js";

const SKIP_OP_RETURN_TYPES = new Set(["victim", "victimCluster", "fanoutCluster"]);

export async function enrichNodesWithOpReturn(store: Store, nodes: GraphNode[]): Promise<void> {
  const others = nodes.filter(
    (node) => node.address && node.type !== "hacker" && !SKIP_OP_RETURN_TYPES.has(node.type),
  );
  const resolved = await store.resolveOpReturnForAddresses(others.map((node) => node.address!));
  for (const node of others) {
    const found = resolved.get(node.address!);
    if (!found?.opReturn) continue;
    node.opReturn = found.opReturn;
    node.opReturnLabel = truncateOpReturnGraphLabel(found.opReturn);
  }

  for (const hacker of nodes) {
    if (hacker.type !== "hacker" || !hacker.address) continue;
    const fromDownstream = nodes.find((node) => node.type === "downstream" && node.opReturn);
    if (!fromDownstream?.opReturn) continue;
    hacker.opReturn = fromDownstream.opReturn;
    hacker.opReturnLabel =
      fromDownstream.opReturnLabel ?? truncateOpReturnGraphLabel(fromDownstream.opReturn);
  }
}
