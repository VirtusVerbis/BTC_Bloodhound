import type { Store } from "@cointrace/db";
import { truncateOpReturnGraphLabel } from "../chain/opReturn.js";
import type { GraphNode } from "./builder.js";

export async function enrichNodesWithOpReturn(store: Store, nodes: GraphNode[]): Promise<void> {
  const addresses = nodes
    .map((n) => n.address)
    .filter((a): a is string => Boolean(a));
  if (addresses.length === 0) return;

  const txidByAddress = new Map<string, string>();
  for (const address of addresses) {
    const timing = await store.resolveHackTimingForAddress(address);
    if (timing.hackTxid) txidByAddress.set(address, timing.hackTxid);
  }

  const displays = await store.getOpReturnDisplayByTxids([...txidByAddress.values()]);
  for (const node of nodes) {
    if (!node.address) continue;
    const txid = txidByAddress.get(node.address);
    if (!txid) continue;
    const text = displays.get(txid);
    if (!text) continue;
    node.opReturn = text;
    node.opReturnLabel = truncateOpReturnGraphLabel(text);
  }
}
