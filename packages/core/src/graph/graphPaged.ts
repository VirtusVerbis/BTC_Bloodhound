import { VICTIM_REFUND_PROBE_LIMIT, type Store } from "@cointrace/db";
import { bundleParallelEdges, mapDbEdgeToGraph } from "./graphEdges.js";
import type { GraphEdge, GraphNode, GraphResult } from "./builder.js";
import { enrichNodesWithOpReturn } from "./graphOpReturn.js";
import { appendVictimRefunds } from "./graphRefunds.js";
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
  l2ParentsDone?: number;
  l2ParentCount?: number;
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
  const minEdgeSats = options.minEdgeSats ?? 100_000;

  if (!options.expandVictims) {
    const victimStats = await store.getVictimStats(hacker, minEdgeSats);
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
  for (const v of await store.listVictimsForHacker(hacker, maxVictims, minEdgeSats)) {
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
  const minEdgeSats = options.minEdgeSats ?? 100_000;
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

  const victimSet = await store.getVictimAddressSetForHacker(
    hacker,
    Math.max(options.maxVictims ?? 100, 1000),
    minEdgeSats,
  );

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
  outEdges = outEdges.filter((e) => !victimSet.has(e.toAddress));

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

  if (isFirstPage) {
    await appendVictimRefunds(store, hacker, nodes, edges, seen, {
      minEdgeSats,
      victimAddresses: [...victimSet].slice(0, VICTIM_REFUND_PROBE_LIMIT),
    });
  }

  const loadedL1 = loadedBefore + outEdges.length;
  const naturalDone = outEdges.length < fetchLimit || fetchLimit === 0;
  const capDone = loadedL1 >= options.maxDownstream;
  const done = naturalDone || capDone;
  const hasMoreEdges = outEdges.length > 0 && !naturalDone;

  const nextCursor = hasMoreEdges
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

function fanoutClusterId(parentId: string): string {
  return `fanout:${parentId}`;
}

function appendFanoutCluster(
  nodes: GraphNode[],
  edges: GraphEdge[],
  parentId: string,
  parentHop: number,
  childCount: number,
  totalSats: number,
): void {
  const clusterId = fanoutClusterId(parentId);
  nodes.push({
    id: clusterId,
    type: "fanoutCluster",
    label: "Fanout",
    role: "downstream",
    childCount,
    totalSats,
    hopFromHacker: parentHop + 1,
  });
  edges.push({
    id: `${parentId}->${clusterId}`,
    source: parentId,
    target: clusterId,
    txid: "",
    amount: totalSats,
    time: null,
  });
}

export async function buildGraphL2Page(
  store: Store,
  l2TokenRaw: string,
  options: {
    limit: number;
    cursor?: string | null;
    loadedL2?: number;
    maxDownstreamOverride?: number;
    spendFanoutTopK?: number;
    expandParent?: string | null;
  },
): Promise<GraphL2PageResult> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const token = decodeL2Token(l2TokenRaw);
  if (!token) throw new Error("invalid l2_token");
  const maxPerParent =
    options.maxDownstreamOverride != null
      ? Math.max(1, Math.floor(options.maxDownstreamOverride))
      : token.maxPerParent;
  const spendFanoutTopK = Math.max(1, Math.floor(options.spendFanoutTopK ?? 5));
  const expandParent = options.expandParent?.trim() || null;

  const l2Cursor = options.cursor ? decodeL2Cursor(options.cursor) : null;
  if (options.cursor && !l2Cursor) throw new Error("invalid cursor");

  const parentAddrMap = await store.getAddressesMap(token.parents);
  const victimSet = await store.getVictimAddressSetForHacker(
    token.hacker,
    Math.max(token.maxPerParent * token.parents.length, 100),
    token.minEdgeSats,
  );
  const allExpandable = token.parents.filter((id: string) => {
    const row = parentAddrMap.get(id);
    return (row?.hopFromHacker ?? 1) < token.maxGraphDepth;
  });
  const expandableParents = expandParent
    ? allExpandable.filter((id) => id === expandParent)
    : allExpandable;

  let parentIndex = l2Cursor?.parentIndex ?? 0;
  let loadedFromParent = l2Cursor?.loadedFromParent ?? 0;
  let edgeAfter =
    l2Cursor?.toAddress
      ? { amountSats: l2Cursor.amountSats, toAddress: l2Cursor.toAddress }
      : undefined;
  let addedThisPage = 0;
  let nextCursor: string | null = null;

  const emitChildren = async (
    parentId: string,
    bundledChild: ReturnType<typeof bundleParallelEdges>,
    cap?: number,
  ): Promise<number> => {
    const slice = cap != null ? bundledChild.slice(0, cap) : bundledChild;
    const childIds = slice.map((ge) => ge.target);
    const childAddrMap = await store.getAddressesMap(childIds);
    let added = 0;
    for (const cge of slice) {
      const cid = cge.target;
      if (!seen.has(cid)) {
        nodes.push(downstreamNodeFromAddress(cid, childAddrMap.get(cid), cge.amount));
        seen.add(cid);
      }
      edges.push(cge);
      added++;
    }
    return added;
  };

  while (parentIndex < expandableParents.length && addedThisPage < options.limit) {
    const parentId = expandableParents[parentIndex]!;
    const remainingPage = options.limit - addedThisPage;
    const remainingParent = maxPerParent - loadedFromParent;
    if (remainingParent <= 0) {
      parentIndex++;
      loadedFromParent = 0;
      edgeAfter = undefined;
      continue;
    }

    const parentRow = parentAddrMap.get(parentId);
    const isFanout = parentRow?.expandProfile === "spend_fanout";
    const collapseFanout =
      isFanout && expandParent == null && loadedFromParent === 0 && !edgeAfter;
    const fetchLimit = collapseFanout
      ? Math.min(spendFanoutTopK + 1, remainingPage, remainingParent)
      : Math.min(remainingPage, remainingParent);

    const childEdges = filterDownstreamEdgesExcludingVictims(
      await store.getOutEdgesFromAddress(parentId, {
        minEdgeSats: token.minEdgeSats,
        limit: fetchLimit,
        after: edgeAfter,
      }),
      victimSet,
    );

    if (childEdges.length === 0) {
      parentIndex++;
      loadedFromParent = 0;
      edgeAfter = undefined;
      continue;
    }

    const childGraphEdges = childEdges.map((ce) => mapDbEdgeToGraph(parentId, ce.toAddress, ce));
    const bundledChild = bundleParallelEdges(childGraphEdges, token.graphBundleMinEdges);

    if (collapseFanout) {
      const topK = bundledChild.slice(0, spendFanoutTopK);
      const added = await emitChildren(parentId, topK);
      addedThisPage += added;
      loadedFromParent += added;

      const totalOut = await store.countOutEdgesFromAddress(parentId, {
        minEdgeSats: token.minEdgeSats,
      });
      const remainingCount = Math.max(0, totalOut - added);
      if (remainingCount > 0 && addedThisPage < options.limit) {
        const topKSum = topK.reduce((sum, ge) => sum + ge.amount, 0);
        const fanoutTotal = parseFanoutMeta(parentRow?.fanoutMetaJson)?.totalOutSats;
        const remainingSats =
          fanoutTotal != null ? Math.max(0, fanoutTotal - topKSum) : 0;
        appendFanoutCluster(
          nodes,
          edges,
          parentId,
          parentRow?.hopFromHacker ?? 1,
          remainingCount,
          remainingSats,
        );
        addedThisPage++;
      }

      parentIndex++;
      loadedFromParent = 0;
      edgeAfter = undefined;
      continue;
    }

    const addCap = Math.min(bundledChild.length, remainingPage, remainingParent);
    const added = await emitChildren(parentId, bundledChild, addCap);
    addedThisPage += added;
    loadedFromParent += added;

    const lastRaw = childEdges[Math.min(childEdges.length, addCap) - 1] ?? childEdges[childEdges.length - 1]!;
    const fetchedFull = childEdges.length >= fetchLimit;
    const parentCapped = loadedFromParent >= maxPerParent;
    const pageFull = addedThisPage >= options.limit;

    if (pageFull && !parentCapped && fetchedFull) {
      nextCursor = encodeL2Cursor({
        parentIndex,
        amountSats: lastRaw.amountSats,
        toAddress: lastRaw.toAddress,
        loadedFromParent,
      });
      break;
    }

    if (parentCapped || !fetchedFull) {
      if (expandParent && parentCapped) {
        const totalOut = await store.countOutEdgesFromAddress(parentId, {
          minEdgeSats: token.minEdgeSats,
        });
        const remainingCount = Math.max(0, totalOut - loadedFromParent);
        if (remainingCount > 0 && addedThisPage < options.limit) {
          appendFanoutCluster(
            nodes,
            edges,
            parentId,
            parentRow?.hopFromHacker ?? 1,
            remainingCount,
            0,
          );
          addedThisPage++;
        }
      }
      parentIndex++;
      loadedFromParent = 0;
      edgeAfter = undefined;
      continue;
    }

    edgeAfter = { amountSats: lastRaw.amountSats, toAddress: lastRaw.toAddress };
  }

  if (nextCursor == null && parentIndex < expandableParents.length) {
    nextCursor = encodeL2Cursor({
      parentIndex,
      amountSats: edgeAfter?.amountSats ?? 0,
      toAddress: edgeAfter?.toAddress ?? "",
      loadedFromParent,
    });
  }

  const done = nextCursor === null && parentIndex >= expandableParents.length;
  const loadedL2 = (options.loadedL2 ?? 0) + addedThisPage;
  const l2ParentsDone = done ? expandableParents.length : parentIndex;
  const l2ParentCount = expandableParents.length;

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
      l2ParentsDone,
      l2ParentCount,
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
