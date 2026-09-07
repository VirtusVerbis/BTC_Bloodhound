import type { Store } from "@cointrace/db";
import { bundleParallelEdges, mapDbEdgeToGraph } from "./graphEdges.js";
import type { GraphEdge, GraphNode, GraphResult } from "./builder.js";
import { enrichNodesWithOpReturn } from "./graphOpReturn.js";
import { filterDownstreamEdgesExcludingVictims } from "./graphVictims.js";
import {
  decodeL1Cursor,
  decodeL2Cursor,
  decodeL2Token,
  encodeL1Cursor,
  encodeL2Cursor,
  encodeL2Token,
  type L2TokenPayload,
} from "./graphTokens.js";

export interface GraphL1PageMeta {
  phase: "l1";
  done: boolean;
  nextCursor: string | null;
  pageSize: number;
  totalL1: number | null;
  loadedL1: number;
  loadId?: string;
}

export interface GraphL2PageMeta {
  phase: "l2";
  done: boolean;
  nextCursor: string | null;
  loadedL2: number;
}

export interface GraphL1PageResult extends GraphResult {
  page: GraphL1PageMeta;
  l2Token: string | null;
}

export interface GraphL2PageResult extends GraphResult {
  page: GraphL2PageMeta;
}

interface RelayMeta {
  receiveTxCount: number;
  spendTxCount: number;
  primarySweepTarget?: string;
  totalReceivedSats?: number;
}

interface FanoutMeta {
  outputCount: number;
  totalOutSats: number;
  txid: string;
  topOutputs?: Array<{ address: string; sats: number }>;
}

function parseRelayMeta(json: string | null | undefined): RelayMeta | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as RelayMeta;
  } catch {
    return undefined;
  }
}

function parseFanoutMeta(json: string | null | undefined): FanoutMeta | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as FanoutMeta;
  } catch {
    return undefined;
  }
}

function downstreamNodeFromAddress(
  id: string,
  downstream: Awaited<ReturnType<Store["getAddress"]>>,
  incomingSats: number,
): GraphNode {
  const expandProfile =
    downstream?.expandProfile === "sweep_relay" || downstream?.expandProfile === "spend_fanout"
      ? downstream.expandProfile
      : null;
  return {
    id,
    type: "downstream",
    label: "Downstream",
    role: "downstream",
    address: id,
    hopFromHacker: downstream?.hopFromHacker ?? 1,
    totalReceivedSats: downstream?.totalReceivedSats ?? incomingSats,
    incomingSats,
    expandProfile,
    relayMeta: parseRelayMeta(downstream?.relayMetaJson),
    fanoutMeta: parseFanoutMeta(downstream?.fanoutMetaJson),
  };
}

async function appendVictimsSection(
  store: Store,
  hacker: string,
  hackerId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  seen: Set<string>,
  options: {
    expandVictims?: boolean;
    maxVictims?: number;
    minEdgeSats?: number;
  },
): Promise<void> {
  const minEdgeSats = options.minEdgeSats ?? 1000;
  const victimStats = await store.getVictimStats(hacker, minEdgeSats);

  if (!options.expandVictims) {
    const clusterId = `victims:${hacker}`;
    nodes.push({
      id: clusterId,
      type: "victimCluster",
      label: "Victims",
      role: "victim",
      childCount: victimStats.childCount,
      totalSats: victimStats.totalSats,
    });
    edges.push({
      id: `${clusterId}->${hackerId}`,
      source: clusterId,
      target: hackerId,
      txid: "",
      amount: victimStats.totalSats,
      time: null,
    });
    return;
  }

  const maxVictims = options.maxVictims ?? 100;
  const victimNodes = new Map<string, GraphNode>();
  for (const v of await store.listVictimsForHacker(hacker, maxVictims)) {
    if (v.amountSats < minEdgeSats) continue;
    const id = v.address;
    let node = victimNodes.get(id);
    if (!node) {
      node = {
        id,
        type: "victim",
        label: "Victim",
        role: "victim",
        address: v.address,
        incomingSats: 0,
      };
      victimNodes.set(id, node);
      nodes.push(node);
      seen.add(id);
    }
    node.incomingSats = (node.incomingSats ?? 0) + v.amountSats;
    if (v.blockTime) {
      if (!node.latestTxTime || v.blockTime > node.latestTxTime) node.latestTxTime = v.blockTime;
      if (!node.earliestTxTime || v.blockTime < node.earliestTxTime) node.earliestTxTime = v.blockTime;
    }
    edges.push({
      id: `${id}->${hackerId}:${v.txid}`,
      source: id,
      target: hackerId,
      txid: v.txid,
      amount: v.amountSats,
      time: v.blockTime,
    });
  }
}

export async function buildGraphL1Page(
  store: Store,
  hacker: string,
  options: {
    limit: number;
    cursor?: string | null;
    loadedL1?: number;
    maxDownstream: number;
    minEdgeSats?: number;
    expandVictims?: boolean;
    maxVictims?: number;
    graphBundleMinEdges?: number;
    maxGraphDepth?: number;
    loadId?: string;
  },
): Promise<GraphL1PageResult> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const minEdgeSats = options.minEdgeSats ?? 1000;
  const graphBundleMinEdges = options.graphBundleMinEdges ?? 2;
  const maxGraphDepth = options.maxGraphDepth ?? 2;
  const loadedBefore = options.loadedL1 ?? 0;
  const isFirstPage = !options.cursor;
  const after = options.cursor ? decodeL1Cursor(options.cursor) : null;
  if (options.cursor && !after) {
    throw new Error("invalid cursor");
  }

  const hackerAddr = await store.getAddress(hacker);
  if (!hackerAddr?.isFlaggedHacker) {
    return {
      nodes,
      edges,
      mode: "hacker",
      page: {
        phase: "l1",
        done: true,
        nextCursor: null,
        pageSize: options.limit,
        totalL1: 0,
        loadedL1: 0,
        loadId: options.loadId,
      },
      l2Token: null,
    };
  }

  const hackerId = hacker;
  if (isFirstPage) {
    nodes.push({
      id: hackerId,
      type: "hacker",
      label: hackerAddr.label ?? "Hacker",
      role: "hacker",
      address: hacker,
      flagged: true,
      totalReceivedSats: hackerAddr.totalReceivedSats,
      liveBalanceSats: hackerAddr.liveBalanceSats,
      liveBalanceAt: hackerAddr.liveBalanceAt,
      hopFromHacker: 0,
    });
    seen.add(hackerId);
    await appendVictimsSection(store, hacker, hackerId, nodes, edges, seen, options);
  }

  const totalL1 = isFirstPage
    ? await store.countOutEdgesFromAddress(hacker, { minEdgeSats })
    : null;

  const remainingCap = Math.max(0, options.maxDownstream - loadedBefore);
  const fetchLimit = Math.min(options.limit, remainingCap);
  let outEdges =
    fetchLimit > 0
      ? await store.getOutEdgesFromAddress(hacker, {
          minEdgeSats,
          limit: fetchLimit,
          after: after ?? undefined,
        })
      : [];

  const hackerOutGraphEdges = outEdges.map((e) => mapDbEdgeToGraph(hackerId, e.toAddress, e));
  const bundledHackerOut = bundleParallelEdges(hackerOutGraphEdges, graphBundleMinEdges);
  const level1Ids = bundledHackerOut.map((ge) => ge.target);
  const level1AddrMap = await store.getAddressesMap(level1Ids);

  for (const ge of bundledHackerOut) {
    const id = ge.target;
    const downstream = level1AddrMap.get(id);
    if (!seen.has(id)) {
      nodes.push(downstreamNodeFromAddress(id, downstream, ge.amount));
      seen.add(id);
    }
    edges.push(ge);
  }

  const loadedL1 = loadedBefore + outEdges.length;
  const naturalDone = outEdges.length < fetchLimit || fetchLimit === 0;
  const capDone = loadedL1 >= options.maxDownstream;
  const done = naturalDone || capDone;

  const nextCursor =
    !done && outEdges.length > 0
      ? encodeL1Cursor({
          amountSats: outEdges[outEdges.length - 1]!.amountSats,
          toAddress: outEdges[outEdges.length - 1]!.toAddress,
        })
      : null;

  let l2Token: string | null = null;
  if (level1Ids.length > 0 && maxGraphDepth > 1) {
    const payload: L2TokenPayload = {
      hacker,
      parents: level1Ids,
      minEdgeSats,
      maxPerParent: options.maxDownstream,
      graphBundleMinEdges,
      maxGraphDepth,
    };
    l2Token = encodeL2Token(payload);
  }

  await enrichNodesWithOpReturn(store, nodes);

  return {
    nodes,
    edges,
    mode: "hacker",
    page: {
      phase: "l1",
      done,
      nextCursor,
      pageSize: options.limit,
      totalL1,
      loadedL1,
      loadId: isFirstPage ? options.loadId : undefined,
    },
    l2Token,
  };
}

export async function buildGraphL2Page(
  store: Store,
  l2TokenRaw: string,
  options: {
    limit: number;
    cursor?: string | null;
    loadedL2?: number;
  },
): Promise<GraphL2PageResult> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const token = decodeL2Token(l2TokenRaw);
  if (!token) throw new Error("invalid l2_token");

  const l2Cursor = options.cursor ? decodeL2Cursor(options.cursor) : null;
  if (options.cursor && !l2Cursor) throw new Error("invalid cursor");

  const parentAddrMap = await store.getAddressesMap(token.parents);
  const victimSet = await store.getVictimAddressSetForHacker(token.hacker);
  const expandableParents = token.parents.filter((id: string) => {
    const row = parentAddrMap.get(id);
    return (row?.hopFromHacker ?? 1) < token.maxGraphDepth;
  });

  let parentIndex = l2Cursor?.parentIndex ?? 0;
  let edgeAfter =
    l2Cursor?.toAddress
      ? { amountSats: l2Cursor.amountSats, toAddress: l2Cursor.toAddress }
      : undefined;
  let addedThisPage = 0;
  let nextCursor: string | null = null;

  while (parentIndex < expandableParents.length && addedThisPage < options.limit) {
    const parentId = expandableParents[parentIndex]!;
    const remaining = options.limit - addedThisPage;
    const childEdges = filterDownstreamEdgesExcludingVictims(
      await store.getOutEdgesFromAddress(parentId, {
        minEdgeSats: token.minEdgeSats,
        limit: Math.min(token.maxPerParent, remaining),
        after: edgeAfter,
      }),
      victimSet,
    );
    // Filtered edges still consume DB limit slots; cursor may skip victim-dust rows.

    if (childEdges.length === 0) {
      parentIndex++;
      edgeAfter = undefined;
      continue;
    }

    const childGraphEdges = childEdges.map((ce) => mapDbEdgeToGraph(parentId, ce.toAddress, ce));
    const bundledChild = bundleParallelEdges(childGraphEdges, token.graphBundleMinEdges);
    const childIds = bundledChild.map((ge) => ge.target);
    const childAddrMap = await store.getAddressesMap(childIds);

    for (const cge of bundledChild) {
      const cid = cge.target;
      const child = childAddrMap.get(cid);
      if (!seen.has(cid)) {
        nodes.push(downstreamNodeFromAddress(cid, child, cge.amount));
        seen.add(cid);
      }
      edges.push(cge);
      addedThisPage++;
      if (addedThisPage >= options.limit) break;
    }

    if (addedThisPage >= options.limit) {
      const lastRaw = childEdges[childEdges.length - 1]!;
      const hitParentCap = childEdges.length >= Math.min(token.maxPerParent, remaining);
      if (hitParentCap) {
        nextCursor = encodeL2Cursor({
          parentIndex,
          amountSats: lastRaw.amountSats,
          toAddress: lastRaw.toAddress,
        });
      } else {
        nextCursor = encodeL2Cursor({
          parentIndex: parentIndex + 1,
          amountSats: 0,
          toAddress: "",
        });
      }
      break;
    }

    if (childEdges.length >= Math.min(token.maxPerParent, remaining)) {
      const last = childEdges[childEdges.length - 1]!;
      nextCursor = encodeL2Cursor({
        parentIndex,
        amountSats: last.amountSats,
        toAddress: last.toAddress,
      });
      break;
    }

    parentIndex++;
    edgeAfter = undefined;
  }

  const done = nextCursor === null && parentIndex >= expandableParents.length;
  const loadedL2 = (options.loadedL2 ?? 0) + addedThisPage;

  await enrichNodesWithOpReturn(store, nodes);

  return {
    nodes,
    edges,
    mode: "hacker",
    page: {
      phase: "l2",
      done,
      nextCursor: done ? null : nextCursor,
      loadedL2,
    },
  };
}

export {
  decodeL1Cursor,
  decodeL2Cursor,
  decodeL2Token,
  encodeL1Cursor,
  encodeL2Cursor,
  encodeL2Token,
} from "./graphTokens.js";
