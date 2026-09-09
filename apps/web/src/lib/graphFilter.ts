import type { ApiGraphEdge, ApiGraphNode, ApiGraphResponse } from "./graphLoader";

export interface GraphLoadParams {
  hacker: string;
  minEdgeSats: number;
  maxVictims: number;
  maxDownstream: number;
  expandVictims: boolean;
}

function filterEdgesToNodes(nodes: ApiGraphNode[], edges: ApiGraphEdge[]): ApiGraphEdge[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  return edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
}

function findHackerId(nodes: ApiGraphNode[]): string | null {
  return nodes.find((n) => n.type === "hacker")?.id ?? null;
}

function applyMinEdgeSats(graph: ApiGraphResponse, minEdgeSats: number): ApiGraphResponse {
  const edges = graph.edges.filter((e) => e.amount >= minEdgeSats || !e.txid);
  const nodeIds = new Set<string>();
  for (const e of edges) {
    nodeIds.add(e.source);
    nodeIds.add(e.target);
  }
  const nodes = graph.nodes.filter((n) => nodeIds.has(n.id));
  return {
    ...graph,
    nodes,
    edges: filterEdgesToNodes(nodes, edges),
  };
}

function applyMaxVictims(graph: ApiGraphResponse, maxVictims: number, expandVictims: boolean): ApiGraphResponse {
  if (!expandVictims) return graph;

  const victims = graph.nodes
    .filter((n) => n.type === "victim")
    .sort((a, b) => (b.incomingSats ?? 0) - (a.incomingSats ?? 0));
  const keepIds = new Set(victims.slice(0, maxVictims).map((n) => n.id));

  const nodes = graph.nodes.filter((n) => n.type !== "victim" || keepIds.has(n.id));
  const edges = graph.edges.filter((e) => {
    const src = nodes.find((n) => n.id === e.source);
    const tgt = nodes.find((n) => n.id === e.target);
    return src != null && tgt != null;
  });
  return { ...graph, nodes, edges: filterEdgesToNodes(nodes, edges) };
}

function applyMaxDownstream(graph: ApiGraphResponse, maxDownstream: number): ApiGraphResponse {
  const hackerId = findHackerId(graph.nodes);
  if (!hackerId) return graph;

  const l1Edges = graph.edges
    .filter((e) => e.source === hackerId && e.target !== hackerId)
    .filter((e) => {
      const target = graph.nodes.find((n) => n.id === e.target);
      return target?.type === "downstream";
    })
    .sort((a, b) => b.amount - a.amount);

  const keptL1 = new Set(l1Edges.slice(0, maxDownstream).map((e) => e.target));
  const keepNodeIds = new Set<string>([hackerId]);

  for (const n of graph.nodes) {
    if (n.type === "victim" || n.type === "victimCluster") keepNodeIds.add(n.id);
  }
  for (const id of keptL1) keepNodeIds.add(id);

  for (const e of graph.edges) {
    if (keptL1.has(e.source) && graph.nodes.find((n) => n.id === e.target)?.type === "downstream") {
      keepNodeIds.add(e.target);
    }
  }

  const nodes = graph.nodes.filter((n) => keepNodeIds.has(n.id));
  const edges = graph.edges.filter((e) => keepNodeIds.has(e.source) && keepNodeIds.has(e.target));
  return { ...graph, nodes, edges: filterEdgesToNodes(nodes, edges) };
}

export function filterGraphByLimits(
  graph: ApiGraphResponse,
  params: GraphLoadParams,
): ApiGraphResponse {
  let out = graph;
  out = applyMinEdgeSats(out, params.minEdgeSats);
  out = applyMaxVictims(out, params.maxVictims, params.expandVictims);
  out = applyMaxDownstream(out, params.maxDownstream);
  return out;
}

export function canTrimLocally(oldParams: GraphLoadParams, newParams: GraphLoadParams): boolean {
  if (oldParams.hacker !== newParams.hacker) return false;
  if (oldParams.expandVictims !== newParams.expandVictims) return false;
  if (newParams.minEdgeSats < oldParams.minEdgeSats) return false;
  if (newParams.maxVictims > oldParams.maxVictims) return false;
  if (newParams.maxDownstream > oldParams.maxDownstream) return false;
  return (
    newParams.minEdgeSats > oldParams.minEdgeSats ||
    newParams.maxVictims < oldParams.maxVictims ||
    newParams.maxDownstream < oldParams.maxDownstream
  );
}

export function canResumeDownstream(oldParams: GraphLoadParams, newParams: GraphLoadParams): boolean {
  return (
    oldParams.hacker === newParams.hacker &&
    oldParams.minEdgeSats === newParams.minEdgeSats &&
    oldParams.maxVictims === newParams.maxVictims &&
    oldParams.expandVictims === newParams.expandVictims &&
    newParams.maxDownstream > oldParams.maxDownstream
  );
}
