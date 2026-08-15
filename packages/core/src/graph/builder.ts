import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { blockTimeIso } from "../chain/esplora.js";
import type { ChainRouter } from "../chain/router.js";
import type { ChainTxDetail } from "../chain/types.js";
import { bundleParallelEdges, mapDbEdgeToGraph, type EdgeKind } from "./graphEdges.js";

export interface HackTraceOptions {
  tx?: ChainTxDetail;
  spendingAddress?: string;
  spendingHop?: number;
}

export type { EdgeKind } from "./graphEdges.js";

export interface RelayMeta {
  receiveTxCount: number;
  spendTxCount: number;
  primarySweepTarget?: string;
  totalReceivedSats?: number;
}

export interface FanoutMeta {
  outputCount: number;
  totalOutSats: number;
  txid: string;
  topOutputs?: Array<{ address: string; sats: number }>;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  role: string;
  address?: string;
  flagged?: boolean;
  childCount?: number;
  totalSats?: number;
  totalReceivedSats?: number;
  liveBalanceSats?: number | null;
  liveBalanceAt?: string | null;
  hopFromHacker?: number | null;
  incomingSats?: number;
  latestTxTime?: string | null;
  earliestTxTime?: string | null;
  expandProfile?: "sweep_relay" | "spend_fanout" | null;
  relayMeta?: RelayMeta;
  fanoutMeta?: FanoutMeta;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  txid: string;
  amount: number;
  time: string | null;
  edgeKind?: EdgeKind;
  bundled?: boolean;
  edgeCount?: number;
  txids?: string[];
  totalAmount?: number;
  outputCount?: number;
  topOutputs?: Array<{ address: string; sats: number }>;
}

export type GraphMode = "hacker" | "victim-filtered" | "victim-centric";

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: GraphMode;
  matchedHackers?: string[];
}

export async function buildGraph(
  store: Store,
  hacker: string,
  options: {
    depth?: number;
    expandVictims?: boolean;
    maxOutputs?: number;
    maxVictims?: number;
    minEdgeSats?: number;
    victimFilter?: string;
    graphBundleMinEdges?: number;
  },
): Promise<GraphResult> {
  const depth = options.depth ?? 1;
  const maxOutputs = options.maxOutputs ?? 100;
  const maxVictims = options.maxVictims ?? 100;
  const minEdgeSats = options.minEdgeSats ?? 1000;
  const victimFilter = options.victimFilter?.trim().toLowerCase();
  const graphBundleMinEdges = options.graphBundleMinEdges ?? 2;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const hackerAddr = await store.getAddress(hacker);
  if (!hackerAddr?.isFlaggedHacker) {
    return { nodes, edges, mode: victimFilter ? "victim-filtered" : "hacker" };
  }

  const hackerId = hacker;
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

  const victimStats = await store.getVictimStats(hacker, minEdgeSats);

  if (victimFilter) {
    // Victim search: load this address's edges directly (ignore maxVictims / minEdgeSats).
    const victimEdges = await store.listEdgesFromVictimToHacker(victimFilter, hacker);
    if (victimEdges.length > 0) {
      const totalIncoming = victimEdges.reduce((s, v) => s + v.amountSats, 0);
      nodes.push({
        id: victimFilter,
        type: "victim",
        label: "Victim",
        role: "victim",
        address: victimFilter,
        incomingSats: totalIncoming,
      });
      seen.add(victimFilter);
      for (const v of victimEdges) {
        edges.push({
          id: `${victimFilter}->${hackerId}:${v.txid}`,
          source: victimFilter,
          target: hackerId,
          txid: v.txid,
          amount: v.amountSats,
          time: v.blockTime,
        });
      }
    }
  } else if (!options.expandVictims) {
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
  } else {
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

  const outEdges = (await store.getEdgesFromAddress(hacker))
    .filter((e) => e.direction === "out_from_hacker" && e.amountSats >= minEdgeSats)
    .sort((a, b) => b.amountSats - a.amountSats)
    .slice(0, maxOutputs);

  const hackerOutGraphEdges = outEdges.map((e) =>
    mapDbEdgeToGraph(hackerId, e.toAddress, e),
  );
  const bundledHackerOut = bundleParallelEdges(hackerOutGraphEdges, graphBundleMinEdges);

  for (const ge of bundledHackerOut) {
    const id = ge.target;
    const downstream = await store.getAddress(id);
    if (!seen.has(id)) {
      nodes.push(downstreamNodeFromAddress(id, downstream, ge.amount));
      seen.add(id);
    }
    edges.push(ge);

    if (depth > 1 && (downstream?.hopFromHacker ?? 1) < depth) {
      const childEdges = (await store.getEdgesFromAddress(id))
        .filter((ce) => ce.direction === "out_from_hacker" && ce.amountSats >= minEdgeSats)
        .sort((a, b) => b.amountSats - a.amountSats)
        .slice(0, maxOutputs);
      const childGraphEdges = childEdges.map((ce) => mapDbEdgeToGraph(id, ce.toAddress, ce));
      const bundledChild = bundleParallelEdges(childGraphEdges, graphBundleMinEdges);
      for (const cge of bundledChild) {
        const cid = cge.target;
        const child = await store.getAddress(cid);
        if (!seen.has(cid)) {
          nodes.push(downstreamNodeFromAddress(cid, child, cge.amount));
          seen.add(cid);
        }
        edges.push(cge);
      }
    }
  }

  return {
    nodes,
    edges,
    mode: victimFilter ? "victim-filtered" : "hacker",
    matchedHackers: victimFilter ? [hacker] : undefined,
  };
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

export async function buildVictimGraph(
  store: Store,
  victim: string,
  options: { minEdgeSats?: number } = {},
): Promise<GraphResult> {
  const normalized = victim.trim().toLowerCase();
  // Victim search: do not apply minEdgeSats when resolving linked hackers.
  const hackers = await store.listHackersForVictim(normalized, options.minEdgeSats);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (hackers.length === 0) {
    return { nodes, edges, mode: "victim-centric", matchedHackers: [] };
  }

  const totalPaid = hackers.reduce((s, h) => s + h.totalSats, 0);
  nodes.push({
    id: normalized,
    type: "victim",
    label: "Victim",
    role: "victim",
    address: normalized,
    incomingSats: totalPaid,
  });

  for (const h of hackers) {
    const hackerAddr = await store.getAddress(h.address);
    nodes.push({
      id: h.address,
      type: "hacker",
      label: h.label ?? hackerAddr?.label ?? "Hacker",
      role: "hacker",
      address: h.address,
      flagged: true,
      totalReceivedSats: hackerAddr?.totalReceivedSats ?? h.totalSats,
      liveBalanceSats: hackerAddr?.liveBalanceSats ?? null,
      liveBalanceAt: hackerAddr?.liveBalanceAt ?? null,
      hopFromHacker: 0,
    });
    edges.push({
      id: `${normalized}->${h.address}`,
      source: normalized,
      target: h.address,
      txid: h.edges[0]?.txid ?? "",
      amount: h.totalSats,
      time: h.edges.find((e) => e.blockTime)?.blockTime ?? null,
    });
  }

  return {
    nodes,
    edges,
    mode: "victim-centric",
    matchedHackers: hackers.map((h) => h.address),
  };
}

export interface HackTraceEdgeDraft {
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  hopFromHacker: number;
  direction: "in_to_hacker" | "out_from_hacker";
}

export interface HackTraceEdges {
  inToHacker: HackTraceEdgeDraft[];
  outFromHacker: HackTraceEdgeDraft[];
  victimAddresses: string[];
}

function aggregateInputsByAddress(tx: ChainTxDetail, hackerAddresses: Set<string>): Map<string, number> {
  const byAddress = new Map<string, number>();
  for (const i of tx.vin) {
    if (i.is_coinbase) continue;
    const addr = i.prevout?.scriptpubkey_address;
    const value = i.prevout?.value;
    if (!addr || value == null || value <= 0) continue;
    if (hackerAddresses.has(addr)) continue;
    byAddress.set(addr, (byAddress.get(addr) ?? 0) + value);
  }
  return byAddress;
}

function aggregateHackerOutputs(tx: ChainTxDetail, hackerAddresses: Set<string>): Map<string, number> {
  const byAddress = new Map<string, number>();
  for (const o of tx.vout) {
    const addr = o.scriptpubkey_address;
    const value = o.value ?? 0;
    if (!addr || value <= 0) continue;
    if (!hackerAddresses.has(addr)) continue;
    byAddress.set(addr, (byAddress.get(addr) ?? 0) + value);
  }
  return byAddress;
}

function splitProportionally(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum <= 0 || total <= 0) return weights.map(() => 0);

  const amounts = weights.map((w) => Math.floor((total * w) / weightSum));
  let remainder = total - amounts.reduce((sum, n) => sum + n, 0);
  const ranked = weights
    .map((w, index) => ({
      index,
      fraction: (total * w) / weightSum - amounts[index]!,
    }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < remainder; i++) {
    amounts[ranked[i % ranked.length]!.index]! += 1;
  }
  return amounts;
}

export function computeHackTraceEdges(
  tx: ChainTxDetail,
  hackerAddresses: Set<string>,
  options?: HackTraceOptions & { maxEdges?: number },
): HackTraceEdges {
  const victimInputs = aggregateInputsByAddress(tx, hackerAddresses);
  const hackerOutputs = aggregateHackerOutputs(tx, hackerAddresses);
  const inToHacker: HackTraceEdgeDraft[] = [];
  const outFromHacker: HackTraceEdgeDraft[] = [];

  const hackerOutEntries = [...hackerOutputs.entries()].filter(([, amount]) => amount > 0);
  const hackerOutAmounts = hackerOutEntries.map(([, amount]) => amount);
  const totalHackerOut = hackerOutAmounts.reduce((sum, n) => sum + n, 0);

  for (const [victim, inputValue] of victimInputs) {
    if (inputValue <= 0 || hackerOutEntries.length === 0) continue;
    const splitAmounts =
      hackerOutEntries.length === 1
        ? [inputValue]
        : splitProportionally(inputValue, hackerOutAmounts);
    for (let i = 0; i < hackerOutEntries.length; i++) {
      const amountSats = splitAmounts[i] ?? 0;
      if (amountSats <= 0) continue;
      inToHacker.push({
        fromAddress: victim,
        toAddress: hackerOutEntries[i]![0],
        amountSats,
        hopFromHacker: 0,
        direction: "in_to_hacker",
      });
    }
  }

  const inputAddresses: string[] = [];
  for (const i of tx.vin) {
    const addr = i.prevout?.scriptpubkey_address;
    if (addr) inputAddresses.push(addr);
  }

  const outputAddresses = new Map<string, number>();
  for (const o of tx.vout) {
    const addr = o.scriptpubkey_address;
    if (addr) outputAddresses.set(addr, (outputAddresses.get(addr) ?? 0) + (o.value ?? 0));
  }

  const spenders = collectSpenders(inputAddresses, hackerAddresses, options);
  const maxEdges = options?.maxEdges ?? Number.POSITIVE_INFINITY;
  let edgeCount = inToHacker.length;
  outer: for (const { address: inAddr, hop } of spenders) {
    for (const [outAddr, amount] of outputAddresses) {
      if (outAddr === inAddr || amount <= 0) continue;
      if (edgeCount >= maxEdges) break outer;
      outFromHacker.push({
        fromAddress: inAddr,
        toAddress: outAddr,
        amountSats: amount,
        hopFromHacker: hop + 1,
        direction: "out_from_hacker",
      });
      edgeCount++;
    }
  }

  return {
    inToHacker,
    outFromHacker,
    victimAddresses: [...victimInputs.keys()],
  };
}

export function collectSpenders(
  inputAddresses: string[],
  hackerAddresses: Set<string>,
  options?: HackTraceOptions,
): Array<{ address: string; hop: number }> {
  const spenders: Array<{ address: string; hop: number }> = [];
  const seen = new Set<string>();

  for (const inAddr of inputAddresses) {
    if (hackerAddresses.has(inAddr) && !seen.has(inAddr)) {
      spenders.push({ address: inAddr, hop: 0 });
      seen.add(inAddr);
    }
  }

  if (options?.spendingAddress && inputAddresses.includes(options.spendingAddress) && !seen.has(options.spendingAddress)) {
    spenders.push({
      address: options.spendingAddress,
      hop: options.spendingHop ?? 0,
    });
  }

  return spenders;
}

export interface HackTraceApplyMeta {
  txid: string;
  blockTime: string | null;
}

export interface HackTraceApplyChunkOptions {
  startEdgeIndex?: number;
  maxEdges?: number;
}

export interface HackTraceApplyChunkResult {
  complete: boolean;
  nextEdgeIndex: number;
  edgesApplied: number;
  traceEdgeTotal: number;
}

function flattenHackTraceEdges(edges: HackTraceEdges): HackTraceEdgeDraft[] {
  return [...edges.inToHacker, ...edges.outFromHacker];
}

export async function applyHackTraceEdgesChunk(
  store: Store,
  meta: HackTraceApplyMeta,
  computed: HackTraceEdges,
  opts?: HackTraceApplyChunkOptions,
): Promise<HackTraceApplyChunkResult> {
  const startEdgeIndex = opts?.startEdgeIndex ?? 0;
  const maxEdges = opts?.maxEdges ?? Number.POSITIVE_INFINITY;
  const flat = flattenHackTraceEdges(computed);
  const totalEdges = flat.length;

  let newVictimAddresses = new Set<string>();
  if (startEdgeIndex === 0 && computed.victimAddresses.length > 0) {
    const existingVictims = await store.getExistingAddressSet(computed.victimAddresses);
    newVictimAddresses = new Set(computed.victimAddresses.filter((a) => !existingVictims.has(a)));
    await store.upsertAddressesBatch(
      computed.victimAddresses.map((address) => ({
        address,
        role: "victim",
        source: "derived",
      })),
    );
  }

  const endIndex = Math.min(totalEdges, startEdgeIndex + maxEdges);
  const slice = flat.slice(startEdgeIndex, endIndex);
  const downstreamRows: Array<{
    address: string;
    role: string;
    source: string;
    hopFromHacker: number;
    expandStatus: string;
  }> = [];
  const edgeRows: Array<{
    fromAddress: string;
    toAddress: string;
    txid: string;
    amountSats: number;
    blockTime: string | null;
    hopFromHacker: number;
    direction: string;
  }> = [];

  for (const edge of slice) {
    if (edge.direction === "out_from_hacker") {
      downstreamRows.push({
        address: edge.toAddress,
        role: "downstream",
        source: "derived",
        hopFromHacker: edge.hopFromHacker,
        expandStatus: "pending",
      });
    }
    edgeRows.push({
      fromAddress: edge.fromAddress,
      toAddress: edge.toAddress,
      txid: meta.txid,
      amountSats: edge.amountSats,
      blockTime: meta.blockTime,
      hopFromHacker: edge.hopFromHacker,
      direction: edge.direction,
    });
  }

  const downstreamAddresses = downstreamRows.map((row) => row.address);
  const existingDownstream = await store.getExistingAddressSet(downstreamAddresses);
  const newDownstreamAddresses = new Set(
    downstreamAddresses.filter((address) => !existingDownstream.has(address)),
  );

  if (downstreamRows.length > 0) {
    await store.upsertAddressesBatch(
      downstreamRows.map((row) => ({
        address: row.address,
        role: row.role,
        source: row.source,
        hopFromHacker: row.hopFromHacker,
        expandStatus: row.expandStatus,
      })),
    );
  }

  const hackersToRecalc = edgeRows.length > 0 ? await store.upsertEdgesBatch(edgeRows) : [];
  if (hackersToRecalc.length > 0) {
    await store.recalcTotalReceivedFor(hackersToRecalc);
  }

  const hackersToBump = new Set<string>();
  for (const edge of slice) {
    if (edge.direction === "in_to_hacker" && newVictimAddresses.has(edge.fromAddress)) {
      hackersToBump.add(edge.toAddress);
    }
  }
  for (const edge of slice) {
    if (edge.direction === "out_from_hacker" && newDownstreamAddresses.has(edge.toAddress)) {
      const roots = await store.findRootHackersForSpender(edge.fromAddress);
      for (const root of roots) hackersToBump.add(root);
    }
  }
  if (hackersToBump.size > 0) {
    await store.bumpHackerGraphActivity([...hackersToBump]);
  }

  const nextEdgeIndex = endIndex;
  return {
    complete: nextEdgeIndex >= totalEdges,
    nextEdgeIndex,
    edgesApplied: slice.length,
    traceEdgeTotal: totalEdges,
  };
}

export async function processTxForHackTrace(
  store: Store,
  router: ChainRouter,
  txid: string,
  hackerAddresses: Set<string>,
  options: HackTraceOptions & {
    maxGraphEdgesPerTx?: number;
    maxEdgesPerJob?: number;
    traceEdgeIndex?: number;
  } = {},
): Promise<{
  traceComplete: boolean;
  nextEdgeIndex: number;
  edgesApplied: number;
  traceEdgeTotal: number;
}> {
  const tx = options.tx ?? (await router.withProvider((p) => p.getTx(txid)));
  const blockTime = blockTimeIso(tx);
  await store.upsertTransaction({
    txid,
    blockHeight: tx.status?.block_height ?? null,
    blockTime,
    feeSats: tx.fee ?? null,
  });

  const maxGraphEdges =
    options.maxGraphEdgesPerTx && options.maxGraphEdgesPerTx > 0
      ? options.maxGraphEdgesPerTx
      : Number.POSITIVE_INFINITY;
  const computed = computeHackTraceEdges(tx, hackerAddresses, {
    ...options,
    maxEdges: maxGraphEdges,
  });

  const maxEdgesPerJob =
    options.maxEdgesPerJob && options.maxEdgesPerJob > 0
      ? options.maxEdgesPerJob
      : Number.POSITIVE_INFINITY;

  const result = await applyHackTraceEdgesChunk(
    store,
    { txid, blockTime },
    computed,
    { startEdgeIndex: options.traceEdgeIndex ?? 0, maxEdges: maxEdgesPerJob },
  );

  return {
    traceComplete: result.complete,
    nextEdgeIndex: result.nextEdgeIndex,
    edgesApplied: result.edgesApplied,
    traceEdgeTotal: result.traceEdgeTotal,
  };
}

export async function getHackerAddressSet(store: Store): Promise<Set<string>> {
  return new Set((await store.listHackers()).map((h) => h.address));
}
