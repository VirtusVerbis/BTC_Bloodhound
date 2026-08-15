import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import {
  BLOCK_GAP,
  COL_GAP,
  downstreamColumnStartX,
  groupDownstreamByHop,
  hopColumnWidth,
  layoutDownstreamByHopGrids,
  layoutGraph,
  layoutVictimGrid,
  NODE_HEIGHT,
  NODE_WIDTH,
  RANK_SEP,
  ROW_GAP,
} from "./layoutGraph";

function node(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function edge(id: string, source: string, target: string): Edge {
  return { id, source, target };
}

const anchor = node("hack", "hacker");
const hop1Start = downstreamColumnStartX(anchor);

function nodeBounds(n: Node) {
  return {
    x: n.position.x,
    y: n.position.y,
    w: NODE_WIDTH,
    h: NODE_HEIGHT,
  };
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 1,
): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

function assertPairwiseNonOverlap(nodes: Node[]) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(boxesOverlap(nodeBounds(nodes[i]!), nodeBounds(nodes[j]!))).toBe(false);
    }
  }
}

describe("downstreamColumnStartX", () => {
  it("starts downstream columns after the hacker node width", () => {
    expect(hop1Start).toBe(NODE_WIDTH + RANK_SEP);
  });
});

describe("layoutDownstreamByHopGrids hop 1", () => {
  it("places 25 hop-1 nodes in a single 10×10 block (column-major fill)", () => {
    const downstream = Array.from({ length: 25 }, (_, i) =>
      node(`d${i}`, "downstream", { hopFromHacker: 1, incomingSats: 1000 - i }),
    );
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", []);
    expect(laid).toHaveLength(25);

    const first = laid.find((n) => n.id === "d0")!;
    const second = laid.find((n) => n.id === "d1")!;
    const col1 = laid.find((n) => n.id === "d10")!;
    const col2 = laid.find((n) => n.id === "d20")!;

    expect(first.position.x).toBe(hop1Start);
    expect(second.position.y).toBe(first.position.y + NODE_HEIGHT + ROW_GAP);
    expect(col1.position.x).toBe(hop1Start + NODE_WIDTH + COL_GAP);
    expect(col1.position.y).toBe(first.position.y);
    expect(col2.position.x).toBe(hop1Start + 2 * (NODE_WIDTH + COL_GAP));
    expect(col2.position.y).toBe(first.position.y);
  });

  it("stacks a second 10×10 block vertically when hop-1 count exceeds 100", () => {
    const downstream = Array.from({ length: 150 }, (_, i) =>
      node(`d${i}`, "downstream", { hopFromHacker: 1, incomingSats: 1000 - i }),
    );
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", []);
    const block0Last = laid.find((n) => n.id === "d99")!;
    const block1First = laid.find((n) => n.id === "d100")!;

    expect(block1First.position.y).toBeGreaterThan(block0Last.position.y);
    expect(block1First.position.y - block0Last.position.y).toBeGreaterThanOrEqual(
      NODE_HEIGHT + BLOCK_GAP,
    );
    expect(block1First.position.x).toBe(hop1Start);
  });

  it("vertically centers the hop grid stack on the hacker anchor", () => {
    const downstream = Array.from({ length: 150 }, (_, i) =>
      node(`d${i}`, "downstream", { hopFromHacker: 1, incomingSats: i }),
    );
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", []);
    const ys = laid.map((n) => n.position.y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys.map((y) => y + NODE_HEIGHT));
    const stackCenter = (minY + maxY) / 2;
    const anchorCenter = anchor.position.y + NODE_HEIGHT / 2;
    expect(stackCenter).toBeCloseTo(anchorCenter, 0);
  });

  it("does not overlap the hacker anchor", () => {
    const downstream = [
      node("d1", "downstream", { hopFromHacker: 1, incomingSats: 5000 }),
      node("d2", "downstream", { hopFromHacker: 1, incomingSats: 4000 }),
    ];
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", []);
    const hackerBounds = nodeBounds(anchor);
    for (const n of laid) {
      expect(boxesOverlap(hackerBounds, nodeBounds(n))).toBe(false);
    }
  });
});

describe("layoutDownstreamByHopGrids hop columns", () => {
  it("places hop 2 in a separate fixed-width column after hop 1", () => {
    const downstream = [
      node("d1", "downstream", { hopFromHacker: 1, incomingSats: 5000 }),
      node("c1", "downstream", { hopFromHacker: 2, incomingSats: 500 }),
    ];
    const edges = [edge("e1", "hack", "d1"), edge("e2", "d1", "c1")];
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", edges);
    const l1 = laid.find((n) => n.id === "d1")!;
    const l2 = laid.find((n) => n.id === "c1")!;

    const hop2Start = hop1Start + hopColumnWidth() + RANK_SEP;
    expect(l1.position.x).toBeGreaterThanOrEqual(hop1Start);
    expect(l1.position.x).toBeLessThan(hop1Start + hopColumnWidth());
    expect(l2.position.x).toBeGreaterThanOrEqual(hop2Start);
    expect(l2.position.x).toBeLessThan(hop2Start + hopColumnWidth());
  });

  it("places hop 3 and hop 4 in progressively farther columns", () => {
    const downstream = [
      node("d1", "downstream", { hopFromHacker: 1 }),
      node("c1", "downstream", { hopFromHacker: 2 }),
      node("c2", "downstream", { hopFromHacker: 3 }),
      node("c3", "downstream", { hopFromHacker: 4 }),
    ];
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", []);
    const colWidth = hopColumnWidth();
    const hopStarts = [0, 1, 2, 3].map((i) => hop1Start + i * (colWidth + RANK_SEP));

    expect(laid.find((n) => n.id === "d1")!.position.x).toBeGreaterThanOrEqual(hopStarts[0]!);
    expect(laid.find((n) => n.id === "d1")!.position.x).toBeLessThan(hopStarts[0]! + colWidth);
    expect(laid.find((n) => n.id === "c1")!.position.x).toBeGreaterThanOrEqual(hopStarts[1]!);
    expect(laid.find((n) => n.id === "c2")!.position.x).toBeGreaterThanOrEqual(hopStarts[2]!);
    expect(laid.find((n) => n.id === "c3")!.position.x).toBeGreaterThanOrEqual(hopStarts[3]!);
  });

  it("places hop 0 in its own column before hop 1", () => {
    const downstream = [
      node("z1", "downstream", { hopFromHacker: 0, incomingSats: 900 }),
      node("d1", "downstream", { hopFromHacker: 1, incomingSats: 500 }),
    ];
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", []);
    const hop0 = laid.find((n) => n.id === "z1")!;
    const hop1 = laid.find((n) => n.id === "d1")!;
    const colWidth = hopColumnWidth();

    expect(hop0.position.x).toBeGreaterThanOrEqual(hop1Start);
    expect(hop0.position.x).toBeLessThan(hop1Start + colWidth);
    expect(hop1.position.x).toBeGreaterThanOrEqual(hop1Start + colWidth + RANK_SEP);
    expect(boxesOverlap(nodeBounds(hop0), nodeBounds(hop1))).toBe(false);
  });

  it("groups hopFromHacker 0 metadata as hop 0", () => {
    const downstream = [node("z1", "downstream", { hopFromHacker: 0 })];
    const grouped = groupDownstreamByHop(downstream, "hack", []);
    expect(grouped.get(0)?.map((n) => n.id)).toEqual(["z1"]);
  });

  it("does not overlap bounding boxes between different hop levels", () => {
    const downstream = [
      node("d1", "downstream", { hopFromHacker: 1, incomingSats: 100 }),
      node("d2", "downstream", { hopFromHacker: 1, incomingSats: 90 }),
      node("c1", "downstream", { hopFromHacker: 2, incomingSats: 50 }),
      node("c2", "downstream", { hopFromHacker: 2, incomingSats: 40 }),
      node("g1", "downstream", { hopFromHacker: 3, incomingSats: 10 }),
    ];
    const laid = layoutDownstreamByHopGrids(downstream, anchor, "hack", []);
    const hop1 = laid.filter((n) => n.id.startsWith("d"));
    const hop2 = laid.filter((n) => n.id.startsWith("c"));
    const hop3 = laid.filter((n) => n.id === "g1");

    for (const a of hop1) {
      for (const b of [...hop2, ...hop3]) {
        expect(boxesOverlap(nodeBounds(a), nodeBounds(b))).toBe(false);
      }
    }
    for (const a of hop2) {
      for (const b of hop3) {
        expect(boxesOverlap(nodeBounds(a), nodeBounds(b))).toBe(false);
      }
    }
  });

  it("infers hop from BFS when hopFromHacker metadata is missing", () => {
    const downstream = [
      node("d1", "downstream", { incomingSats: 100 }),
      node("c1", "downstream", { incomingSats: 50 }),
    ];
    const edges = [edge("e1", "hack", "d1"), edge("e2", "d1", "c1")];
    const grouped = groupDownstreamByHop(downstream, "hack", edges);
    expect(grouped.get(1)?.map((n) => n.id)).toEqual(["d1"]);
    expect(grouped.get(2)?.map((n) => n.id)).toEqual(["c1"]);
  });
});

describe("layoutVictimGrid regression", () => {
  it("keeps victims in columns to the left of the hacker", () => {
    const victims = Array.from({ length: 5 }, (_, i) =>
      node(`v${i}`, "victim", { incomingSats: 100 - i }),
    );
    const laid = layoutVictimGrid(victims, anchor);
    for (const v of laid) {
      expect(v.position.x).toBeLessThan(anchor.position.x - RANK_SEP);
    }
    expect(laid[0]!.id).toBe("v0");
  });
});

describe("layoutGraph integration", () => {
  it("lays out hacker, hop grids, and victims together", () => {
    const nodes = [
      anchor,
      node("v0", "victim", { incomingSats: 9000 }),
      node("d1", "downstream", { hopFromHacker: 1, incomingSats: 5000 }),
      node("d2", "downstream", { hopFromHacker: 1, incomingSats: 4000 }),
      node("c1", "downstream", { hopFromHacker: 2, incomingSats: 500 }),
    ];
    const edges = [
      edge("ev", "v0", "hack"),
      edge("e1", "hack", "d1"),
      edge("e2", "hack", "d2"),
      edge("e3", "d1", "c1"),
    ];

    const laid = layoutGraph(nodes, edges);
    const hacker = laid.find((n) => n.id === "hack")!;
    const victim = laid.find((n) => n.id === "v0")!;
    const l1 = laid.find((n) => n.id === "d1")!;
    const l2 = laid.find((n) => n.id === "c1")!;

    expect(hacker.position).toEqual({ x: 0, y: 0 });
    expect(victim.position.x).toBeLessThan(0);
    expect(l1.position.x).toBeGreaterThanOrEqual(hop1Start);
    expect(l2.position.x).toBeGreaterThanOrEqual(hop1Start + hopColumnWidth() + RANK_SEP);
  });

  it("places victim cluster left of hacker without overlap", () => {
    const nodes = [
      anchor,
      node("victims:hack", "victimCluster", { childCount: 4, totalSats: 1_000_000 }),
      node("d1", "downstream", { hopFromHacker: 1, incomingSats: 100 }),
    ];
    const edges = [edge("e1", "victims:hack", "hack"), edge("e2", "hack", "d1")];

    const laid = layoutGraph(nodes, edges);
    const hacker = laid.find((n) => n.id === "hack")!;
    const cluster = laid.find((n) => n.id === "victims:hack")!;
    const downstream = laid.find((n) => n.id === "d1")!;

    expect(cluster.position.x + NODE_WIDTH).toBeLessThanOrEqual(hacker.position.x - RANK_SEP + 1);
    assertPairwiseNonOverlap([hacker, cluster, downstream]);
  });

  it("keeps victims, hacker, and downstream pairwise non-overlapping", () => {
    const nodes = [
      anchor,
      node("v0", "victim", { incomingSats: 9000 }),
      node("v1", "victim", { incomingSats: 8000 }),
      node("z1", "downstream", { hopFromHacker: 0, incomingSats: 800 }),
      node("d1", "downstream", { hopFromHacker: 1, incomingSats: 5000 }),
      node("c1", "downstream", { hopFromHacker: 2, incomingSats: 500 }),
    ];
    const edges = [
      edge("ev0", "v0", "hack"),
      edge("ev1", "v1", "hack"),
      edge("e1", "hack", "d1"),
      edge("e2", "d1", "c1"),
    ];

    const laid = layoutGraph(nodes, edges);
    assertPairwiseNonOverlap(laid);
  });
});
