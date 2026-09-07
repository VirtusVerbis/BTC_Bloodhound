/** Drop downstream edges whose target is a known victim (avoids graph loopback to victim nodes). */
export function filterDownstreamEdgesExcludingVictims<T extends { toAddress: string }>(
  edges: T[],
  victimSet: Set<string>,
): T[] {
  if (victimSet.size === 0) return edges;
  return edges.filter((edge) => !victimSet.has(edge.toAddress));
}
