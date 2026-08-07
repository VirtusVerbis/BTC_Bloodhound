import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 120;
const MAX_ROWS_PER_COLUMN = 10;
const ROW_GAP = 24;
const COL_GAP = 40;
const RANK_SEP = 100;

export type VictimSortOption = "btc-desc" | "btc-asc" | "date-desc" | "date-asc";

type VictimNodeData = {
  incomingSats?: number;
  latestTxTime?: string | null;
  earliestTxTime?: string | null;
};

export interface VictimGridOptions {
  maxRows?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  rowGap?: number;
  colGap?: number;
  sortBy?: VictimSortOption;
}

function victimData(node: Node): VictimNodeData {
  return node.data as VictimNodeData;
}

function victimIncomingSats(node: Node): number {
  return victimData(node).incomingSats ?? 0;
}

function compareIsoTime(a: string | null | undefined, b: string | null | undefined, asc: boolean): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return asc ? a.localeCompare(b) : b.localeCompare(a);
}

function compareVictims(a: Node, b: Node, sortBy: VictimSortOption): number {
  switch (sortBy) {
    case "btc-asc": {
      const byAmount = victimIncomingSats(a) - victimIncomingSats(b);
      return byAmount !== 0 ? byAmount : a.id.localeCompare(b.id);
    }
    case "date-desc": {
      const byDate = compareIsoTime(victimData(a).latestTxTime, victimData(b).latestTxTime, false);
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    }
    case "date-asc": {
      const byDate = compareIsoTime(victimData(a).earliestTxTime, victimData(b).earliestTxTime, true);
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    }
    case "btc-desc":
    default: {
      const byAmount = victimIncomingSats(b) - victimIncomingSats(a);
      return byAmount !== 0 ? byAmount : a.id.localeCompare(b.id);
    }
  }
}

export function layoutVictimGrid(
  victims: Node[],
  anchor: Node,
  options: VictimGridOptions = {},
): Node[] {
  const maxRows = options.maxRows ?? MAX_ROWS_PER_COLUMN;
  const nodeWidth = options.nodeWidth ?? NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT;
  const rowGap = options.rowGap ?? ROW_GAP;
  const colGap = options.colGap ?? COL_GAP;
  const sortBy = options.sortBy ?? "btc-desc";

  const sorted = [...victims].sort((a, b) => compareVictims(a, b, sortBy));
  const tallestColumn = Math.min(maxRows, sorted.length);

  const blockHeight = tallestColumn * nodeHeight + (tallestColumn - 1) * rowGap;
  const anchorCenterY = anchor.position.y + nodeHeight / 2;
  const gridTopY = anchorCenterY - blockHeight / 2;

  return sorted.map((node, i) => {
    const col = Math.floor(i / maxRows);
    const row = i % maxRows;
    const x =
      anchor.position.x - RANK_SEP - nodeWidth - col * (nodeWidth + colGap);
    const y = gridTopY + row * (nodeHeight + rowGap);

    return {
      ...node,
      position: { x, y },
    };
  });
}

function dagreLayout(nodes: Node[], edges: Edge[], direction = "LR"): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: RANK_SEP });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });
}

export function layoutVictimCentricGraph(victim: Node, hackers: Node[]): Node[] {
  const nodeHeight = NODE_HEIGHT;
  const rowGap = ROW_GAP;
  const blockHeight = hackers.length * nodeHeight + Math.max(0, hackers.length - 1) * rowGap;
  const victimCenterY = blockHeight / 2;
  const victimX = 0;
  const hackerX = NODE_WIDTH + RANK_SEP + 80;

  const laidVictim: Node = {
    ...victim,
    position: { x: victimX, y: victimCenterY - nodeHeight / 2 },
  };

  const gridTopY = 0;
  const laidHackers = hackers.map((node, i) => ({
    ...node,
    position: {
      x: hackerX,
      y: gridTopY + i * (nodeHeight + rowGap),
    },
  }));

  return [laidVictim, ...laidHackers];
}

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction = "LR",
  mode: "hacker" | "victim-filtered" | "victim-centric" = "hacker",
  victimSort: VictimSortOption = "btc-desc",
) {
  if (mode === "victim-centric") {
    const victim = nodes.find((n) => n.type === "victim");
    const hackers = nodes.filter((n) => n.type === "hacker");
    if (victim && hackers.length > 0) {
      return layoutVictimCentricGraph(victim, hackers);
    }
  }

  const victimIds = new Set(nodes.filter((n) => n.type === "victim").map((n) => n.id));
  const victims = nodes.filter((n) => n.type === "victim");
  const others = nodes.filter((n) => n.type !== "victim");

  const layoutEdges = edges.filter(
    (e) => !victimIds.has(e.source) && !victimIds.has(e.target),
  );

  const laidOthers = dagreLayout(others, layoutEdges, direction);

  if (victims.length === 0) {
    return laidOthers;
  }

  const hacker =
    laidOthers.find((n) => n.type === "hacker") ??
    laidOthers.find((n) => n.type === "victimCluster") ??
    laidOthers[0];

  const gridOptions = { maxRows: MAX_ROWS_PER_COLUMN, sortBy: victimSort };

  if (!hacker) {
    return [...laidOthers, ...layoutVictimGrid(victims, victims[0]!, gridOptions)];
  }

  const gridVictims = layoutVictimGrid(victims, hacker, gridOptions);
  return [...laidOthers, ...gridVictims];
}
