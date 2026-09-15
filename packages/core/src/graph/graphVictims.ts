import type { Store } from "@cointrace/db";

/** Drop downstream edges whose target is a known victim (avoids graph loopback to victim nodes). */
export function filterDownstreamEdgesExcludingVictims<T extends { toAddress: string }>(
  edges: T[],
  victimSet: Set<string>,
): T[] {
  if (victimSet.size === 0) return edges;
  return edges.filter((edge) => !victimSet.has(edge.toAddress));
}

/** Fetch which of these edge targets paid this hacker, then drop those edges. */
export async function excludeEdgesToHackerVictims<T extends { toAddress: string }>(
  store: Store,
  edges: T[],
  hacker: string,
  minEdgeSats?: number,
): Promise<T[]> {
  if (edges.length === 0) return edges;
  const victims = await store.filterVictimTargetsOfHacker(
    edges.map((edge) => edge.toAddress),
    hacker,
    minEdgeSats,
  );
  return filterDownstreamEdgesExcludingVictims(edges, victims);
}
