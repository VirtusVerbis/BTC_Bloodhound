import type { Edge, Node } from "@xyflow/react";

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 200;
const MAX_ROWS_PER_COLUMN = 10;
const MAX_COLS_PER_BLOCK = 10;
const MAX_NODES_PER_HOP_BLOCK = 100;
const HOP_GRID_COLS = 10;
export const ROW_GAP = 24;
export const COL_GAP = 40;
export const RANK_SEP = 100;
export const BLOCK_GAP = 80;

export type VictimSortOption = "btc-desc" | "btc-asc" | "date-desc" | "date-asc";

type GridNodeData = {
  incomingSats?: number;
  latestTxTime?: string | null;
  earliestTxTime?: string | null;
  hopFromHacker?: number | null;
};

export interface VictimGridOptions {
  maxRows?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  rowGap?: number;
  colGap?: number;
  sortBy?: VictimSortOption;
}

export interface NodeGridOptions extends VictimGridOptions {
  side: "left" | "right";
  maxCols?: number | null;
  maxNodesPerBlock?: number | null;
  blockGap?: number;
}

function gridNodeData(node: Node): GridNodeData {
  return node.data as GridNodeData;
}

function nodeIncomingSats(node: Node): number {
  return gridNodeData(node).incomingSats ?? 0;
}

function compareIsoTime(a: string | null | undefined, b: string | null | undefined, asc: boolean): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return asc ? a.localeCompare(b) : b.localeCompare(a);
}

function compareGridNodes(a: Node, b: Node, sortBy: VictimSortOption): number {
  switch (sortBy) {
    case "btc-asc": {
      const byAmount = nodeIncomingSats(a) - nodeIncomingSats(b);
      return byAmount !== 0 ? byAmount : a.id.localeCompare(b.id);
    }
    case "date-desc": {
      const byDate = compareIsoTime(gridNodeData(a).latestTxTime, gridNodeData(b).latestTxTime, false);
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    }
    case "date-asc": {
      const byDate = compareIsoTime(gridNodeData(a).earliestTxTime, gridNodeData(b).earliestTxTime, true);
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    }
    case "btc-desc":
    default: {
      const byAmount = nodeIncomingSats(b) - nodeIncomingSats(a);
      return byAmount !== 0 ? byAmount : a.id.localeCompare(b.id);
    }
  }
}

function columnsInBlock(count: number, maxRows: number, maxCols: number | null): number {
  if (count === 0) return 0;
  const cols = Math.ceil(count / maxRows);
  return maxCols != null ? Math.min(maxCols, cols) : cols;
}

function tallestColumnInBlock(count: number, maxRows: number, maxCols: number | null): number {
  if (count === 0) return 0;
  const cols = columnsInBlock(count, maxRows, maxCols);
  return cols <= 1 ? Math.min(maxRows, count) : maxRows;
}

function blockHeight(
  count: number,
  maxRows: number,
  maxCols: number | null,
  nodeHeight: number,
  rowGap: number,
): number {
  const tallest = tallestColumnInBlock(count, maxRows, maxCols);
  if (tallest === 0) return 0;
  return tallest * nodeHeight + (tallest - 1) * rowGap;
}

function positionInBlock(
  indexInBlock: number,
  maxRows: number,
  side: "left" | "right",
  anchor: Node,
  blockOriginX: number,
  blockOriginY: number,
  nodeWidth: number,
  nodeHeight: number,
  rowGap: number,
  colGap: number,
): { x: number; y: number } {
  const col = Math.floor(indexInBlock / maxRows);
  const row = indexInBlock % maxRows;
  const y = blockOriginY + row * (nodeHeight + rowGap);
  const colOffset = col * (nodeWidth + colGap);
  const x =
    side === "left"
      ? anchor.position.x - RANK_SEP - nodeWidth - colOffset
      : blockOriginX + colOffset;
  return { x, y };
}

/** Column-major grid fill; supports capped 10×10 blocks stacked vertically. */
export function layoutNodeGrid(nodes: Node[], anchor: Node, options: NodeGridOptions): Node[] {
  const maxRows = options.maxRows ?? MAX_ROWS_PER_COLUMN;
  const maxCols = options.maxCols ?? null;
  const maxNodesPerBlock = options.maxNodesPerBlock ?? null;
  const nodeWidth = options.nodeWidth ?? NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? NODE_HEIGHT;
  const rowGap = options.rowGap ?? ROW_GAP;
  const colGap = options.colGap ?? COL_GAP;
  const blockGap = options.blockGap ?? BLOCK_GAP;
  const sortBy = options.sortBy ?? "btc-desc";
  const side = options.side;

  const sorted = [...nodes].sort((a, b) => compareGridNodes(a, b, sortBy));

  if (maxNodesPerBlock == null) {
    const totalHeight = blockHeight(sorted.length, maxRows, maxCols, nodeHeight, rowGap);
    const anchorCenterY = anchor.position.y + nodeHeight / 2;
    const gridTopY = anchorCenterY - totalHeight / 2;
    const blockOriginX =
      side === "right" ? anchor.position.x + RANK_SEP : anchor.position.x - RANK_SEP - nodeWidth;

    return sorted.map((node, i) => ({
      ...node,
      position: positionInBlock(
        i,
        maxRows,
        side,
        anchor,
        blockOriginX,
        gridTopY,
        nodeWidth,
        nodeHeight,
        rowGap,
        colGap,
      ),
    }));
  }

  const blockCount = Math.ceil(sorted.length / maxNodesPerBlock) || 0;
  const blockHeights = Array.from({ length: blockCount }, (_, blockIndex) => {
    const start = blockIndex * maxNodesPerBlock;
    const count = Math.min(maxNodesPerBlock, sorted.length - start);
    return blockHeight(count, maxRows, maxCols, nodeHeight, rowGap);
  });
  const totalStackHeight =
    blockHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, blockCount - 1) * blockGap;
  const anchorCenterY = anchor.position.y + nodeHeight / 2;
  const stackTopY = anchorCenterY - totalStackHeight / 2;
  const blockOriginX = anchor.position.x + RANK_SEP;

  let blockTopY = stackTopY;
  const laid: Node[] = [];

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const start = blockIndex * maxNodesPerBlock;
    const blockNodes = sorted.slice(start, start + maxNodesPerBlock);
    blockNodes.forEach((node, i) => {
      laid.push({
        ...node,
        position: positionInBlock(
          i,
          maxRows,
          side,
          anchor,
          blockOriginX,
          blockTopY,
          nodeWidth,
          nodeHeight,
          rowGap,
          colGap,
        ),
      });
    });
    blockTopY += blockHeights[blockIndex]! + blockGap;
  }

  return laid;
}

export function hopColumnWidth(
  nodeWidth = NODE_WIDTH,
  colGap = COL_GAP,
  cols = HOP_GRID_COLS,
): number {
  return cols * nodeWidth + (cols - 1) * colGap;
}

export function downstreamColumnStartX(anchor: Node): number {
  return anchor.position.x + NODE_WIDTH + RANK_SEP;
}

export function layoutVictimGrid(
  victims: Node[],
  anchor: Node,
  options: VictimGridOptions = {},
): Node[] {
  return layoutNodeGrid(victims, anchor, {
    ...options,
    side: "left",
    maxCols: null,
    maxNodesPerBlock: null,
  });
}

function buildHopDepthMap(
  hackerId: string | undefined,
  downstreamIds: Set<string>,
  edges: Edge[],
): Map<string, number> {
  const hops = new Map<string, number>();
  if (!hackerId) return hops;

  const queue: Array<{ id: string; hop: number }> = [];
  for (const e of edges) {
    if (e.source === hackerId && downstreamIds.has(e.target)) {
      queue.push({ id: e.target, hop: 1 });
    }
  }

  while (queue.length > 0) {
    const { id, hop } = queue.shift()!;
    if (hops.has(id)) continue;
    hops.set(id, hop);
    for (const e of edges) {
      if (e.source === id && downstreamIds.has(e.target) && !hops.has(e.target)) {
        queue.push({ id: e.target, hop: hop + 1 });
      }
    }
  }

  return hops;
}

function resolveDownstreamHop(
  node: Node,
  hopDepthMap: Map<string, number>,
  hackerId: string | undefined,
  edges: Edge[],
): number | null {
  const metaHop = gridNodeData(node).hopFromHacker;
  if (metaHop != null && metaHop >= 0) return metaHop;

  const bfsHop = hopDepthMap.get(node.id);
  if (bfsHop != null) return bfsHop;

  if (hackerId && edges.some((e) => e.source === hackerId && e.target === node.id)) return 1;
  return null;
}

export function groupDownstreamByHop(
  downstreamNodes: Node[],
  hackerId: string | undefined,
  edges: Edge[],
): Map<number, Node[]> {
  const downstreamIds = new Set(downstreamNodes.map((n) => n.id));
  const hopDepthMap = buildHopDepthMap(hackerId, downstreamIds, edges);
  const byHop = new Map<number, Node[]>();

  for (const node of downstreamNodes) {
    const hop = resolveDownstreamHop(node, hopDepthMap, hackerId, edges);
    if (hop == null || hop < 0) continue;
    const list = byHop.get(hop) ?? [];
    list.push(node);
    byHop.set(hop, list);
  }

  return byHop;
}

export function layoutDownstreamByHopGrids(
  downstreamNodes: Node[],
  anchor: Node,
  hackerId: string | undefined,
  edges: Edge[],
  sortBy: VictimSortOption = "btc-desc",
): Node[] {
  const byHop = groupDownstreamByHop(downstreamNodes, hackerId, edges);
  const sortedHops = [...byHop.keys()].sort((a, b) => a - b);
  if (sortedHops.length === 0) return [];

  const columnWidth = hopColumnWidth();
  let columnStartX = downstreamColumnStartX(anchor);
  const laid: Node[] = [];

  for (const hop of sortedHops) {
    const hopNodes = byHop.get(hop)!;
    const virtualAnchor: Node = {
      ...anchor,
      id: `${anchor.id}:hop${hop}`,
      position: { x: columnStartX - RANK_SEP, y: anchor.position.y },
    };
    laid.push(
      ...layoutNodeGrid(hopNodes, virtualAnchor, {
        side: "right",
        maxRows: MAX_ROWS_PER_COLUMN,
        maxCols: MAX_COLS_PER_BLOCK,
        maxNodesPerBlock: MAX_NODES_PER_HOP_BLOCK,
        blockGap: BLOCK_GAP,
        sortBy,
      }),
    );
    columnStartX += columnWidth + RANK_SEP;
  }

  return laid;
}

export function layoutVictimCentricGraph(victim: Node, hackers: Node[]): Node[] {
  const nodeHeight = NODE_HEIGHT;
  const rowGap = ROW_GAP;
  const blockHeightVal = hackers.length * nodeHeight + Math.max(0, hackers.length - 1) * rowGap;
  const victimCenterY = blockHeightVal / 2;
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

function findAnchorNode(nodes: Node[]): Node | undefined {
  return (
    nodes.find((n) => n.type === "hacker") ??
    nodes.find((n) => n.type === "victimCluster") ??
    nodes[0]
  );
}

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  _direction = "LR",
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

  const victims = nodes.filter((n) => n.type === "victim");
  const victimCluster = nodes.find((n) => n.type === "victimCluster");
  const anchorRaw = findAnchorNode(nodes.filter((n) => n.type !== "victim"));
  const hackerId = nodes.find((n) => n.type === "hacker")?.id;

  const anchor: Node = anchorRaw
    ? { ...anchorRaw, position: { x: 0, y: 0 } }
    : { id: "__anchor__", type: "hacker", position: { x: 0, y: 0 }, data: {} };

  const downstream = nodes.filter((n) => n.type === "downstream");
  const miscNodes = nodes.filter(
    (n) =>
      n.type !== "victim" &&
      n.type !== "victimCluster" &&
      n.type !== "downstream" &&
      n.id !== anchor.id,
  );

  const laidAnchor = anchorRaw ? [anchor] : [];
  const laidCluster = victimCluster
    ? layoutVictimGrid([victimCluster], anchor, { sortBy: victimSort })
    : [];
  const laidDownstream = layoutDownstreamByHopGrids(downstream, anchor, hackerId, edges, victimSort);
  const laidVictims = victims.length > 0 ? layoutVictimGrid(victims, anchor, { sortBy: victimSort }) : [];
  const laidMisc = miscNodes.map((n) => ({
    ...n,
    position: anchor.position,
  }));

  return [...laidAnchor, ...laidCluster, ...laidDownstream, ...laidVictims, ...laidMisc];
}
