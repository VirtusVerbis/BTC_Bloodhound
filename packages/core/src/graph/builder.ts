import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { blockTimeIso } from "../chain/esplora.js";
import type { ChainRouter } from "../chain/router.js";
import type { ChainTxDetail } from "../chain/types.js";

export interface HackTraceOptions {
  tx?: ChainTxDetail;
  spendingAddress?: string;
  spendingHop?: number;
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
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  txid: string;
  amount: number;
  time: string | null;
}

export type GraphMode = "hacker" | "victim-filtered" | "victim-centric";

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: GraphMode;
  matchedHackers?: string[];
}

export function buildGraph(
  store: Store,
  hacker: string,
  options: {
    depth?: number;
    expandVictims?: boolean;
    maxOutputs?: number;
    minEdgeSats?: number;
    victimFilter?: string;
  },
): GraphResult {
  const depth = options.depth ?? 1;
  const maxOutputs = options.maxOutputs ?? 20;
  const minEdgeSats = options.minEdgeSats ?? 1000;
  const victimFilter = options.victimFilter?.trim().toLowerCase();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const hackerAddr = store.getAddress(hacker);
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

  const victimStats = store.getVictimStats(hacker, minEdgeSats);

  if (victimFilter) {
    const victimEdges = store
      .listVictimsForHacker(hacker, 100)
      .filter((v) => v.address.toLowerCase() === victimFilter && v.amountSats >= minEdgeSats);
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
    for (const v of store.listVictimsForHacker(hacker, 100)) {
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

  const outEdges = store
    .getEdgesFromAddress(hacker)
    .filter((e) => e.direction === "out_from_hacker" && e.amountSats >= minEdgeSats)
    .sort((a, b) => b.amountSats - a.amountSats)
    .slice(0, maxOutputs);

  for (const e of outEdges) {
    const id = e.toAddress;
    const downstream = store.getAddress(id);
    if (!seen.has(id)) {
      nodes.push({
        id,
        type: "downstream",
        label: "Downstream",
        role: "downstream",
        address: id,
        hopFromHacker: downstream?.hopFromHacker ?? 1,
        totalReceivedSats: downstream?.totalReceivedSats ?? e.amountSats,
        incomingSats: e.amountSats,
      });
      seen.add(id);
    }
    edges.push({
      id: `${hackerId}->${id}:${e.txid}`,
      source: hackerId,
      target: id,
      txid: e.txid,
      amount: e.amountSats,
      time: e.blockTime,
    });

    if (depth > 1 && (downstream?.hopFromHacker ?? 1) < depth) {
      const childEdges = store
        .getEdgesFromAddress(id)
        .filter((ce) => ce.direction === "out_from_hacker" && ce.amountSats >= minEdgeSats)
        .sort((a, b) => b.amountSats - a.amountSats)
        .slice(0, maxOutputs);
      for (const ce of childEdges) {
        const cid = ce.toAddress;
        const child = store.getAddress(cid);
        if (!seen.has(cid)) {
          nodes.push({
            id: cid,
            type: "downstream",
            label: "Downstream",
            role: "downstream",
            address: cid,
            hopFromHacker: child?.hopFromHacker ?? (downstream?.hopFromHacker ?? 1) + 1,
            incomingSats: ce.amountSats,
          });
          seen.add(cid);
        }
        edges.push({
          id: `${id}->${cid}:${ce.txid}`,
          source: id,
          target: cid,
          txid: ce.txid,
          amount: ce.amountSats,
          time: ce.blockTime,
        });
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

export function buildVictimGraph(
  store: Store,
  victim: string,
  options: { minEdgeSats?: number },
): GraphResult {
  const minEdgeSats = options.minEdgeSats ?? 1000;
  const normalized = victim.trim().toLowerCase();
  const hackers = store.listHackersForVictim(normalized, minEdgeSats);
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
    const hackerAddr = store.getAddress(h.address);
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

export async function processTxForHackTrace(
  store: Store,
  router: ChainRouter,
  txid: string,
  hackerAddresses: Set<string>,
  options: HackTraceOptions = {},
): Promise<void> {
  const tx = options.tx ?? (await router.withProvider((p) => p.getTx(txid)));
  const blockTime = blockTimeIso(tx);
  store.upsertTransaction({
    txid,
    blockHeight: tx.status?.block_height ?? null,
    blockTime,
    feeSats: tx.fee ?? null,
  });

  const outputAddresses = new Map<string, number>();
  for (const o of tx.vout) {
    const addr = o.scriptpubkey_address;
    if (addr) outputAddresses.set(addr, (outputAddresses.get(addr) ?? 0) + (o.value ?? 0));
  }

  const inputAddresses: string[] = [];
  for (const i of tx.vin) {
    const addr = i.prevout?.scriptpubkey_address;
    if (addr) inputAddresses.push(addr);
  }

  for (const [outAddr, amount] of outputAddresses) {
    if (hackerAddresses.has(outAddr)) {
      for (const inAddr of inputAddresses) {
        if (inAddr === outAddr) continue;
        store.upsertAddress({ address: inAddr, role: "victim", source: "derived" });
        store.upsertEdge({
          fromAddress: inAddr,
          toAddress: outAddr,
          txid,
          amountSats: amount,
          blockTime,
          hopFromHacker: 0,
          direction: "in_to_hacker",
        });
      }
    }
  }

  const spenders = collectSpenders(inputAddresses, hackerAddresses, options);
  for (const { address: inAddr, hop } of spenders) {
    for (const [outAddr, amount] of outputAddresses) {
      if (outAddr === inAddr) continue;
      store.upsertAddress({
        address: outAddr,
        role: "downstream",
        source: "derived",
        hopFromHacker: hop + 1,
        expandStatus: "pending",
      });
      store.upsertEdge({
        fromAddress: inAddr,
        toAddress: outAddr,
        txid,
        amountSats: amount,
        blockTime,
        hopFromHacker: hop + 1,
        direction: "out_from_hacker",
      });
    }
  }
}

/** @deprecated Use processTxForHackTrace */
export async function processTxForHackerContext(
  store: Store,
  router: ChainRouter,
  txid: string,
  hackerAddresses: Set<string>,
  parentHop = 0,
): Promise<void> {
  await processTxForHackTrace(store, router, txid, hackerAddresses, { spendingHop: parentHop });
}

export function getHackerAddressSet(store: Store): Set<string> {
  return new Set(store.listHackers().map((h) => h.address));
}
