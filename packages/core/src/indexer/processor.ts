import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Job, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { txInvolvesSpend } from "../chain/esplora.js";
import { getHackerAddressSet, processTxForHackTrace } from "../graph/builder.js";
import { applyColdcardWatchSync, fetchColdcardWatch } from "../sources/coldcardwatch.js";
import {
  applyColdcardHackTrackerSync,
  fetchColdcardHackTracker,
} from "../sources/coldcardHackTracker.js";
import { applyColdcardSweepWatchSync, fetchColdcardSweepWatch } from "../sources/coldcardSweepWatch.js";
import { fetchMempoolBtcUsd } from "../price/mempoolPrices.js";
import { processTxPriority } from "./rebuildMode.js";

export interface BackfillPayload {
  address: string;
  chainCursor?: string;
  pendingTxids?: string[];
  processedIndex?: number;
  pagesExhausted?: boolean;
  newestTxid?: string;
  newestBlockHeight?: number | null;
}

async function processAddressTxs(
  store: Store,
  router: ChainRouter,
  address: string,
  txs: Array<{ txid: string }>,
  hackers: Set<string>,
  hop: number,
): Promise<void> {
  for (const t of txs) {
    const tx = await router.withProvider((p) => p.getTx(t.txid));
    if (!txInvolvesSpend(tx, address)) continue;
    await processTxForHackTrace(store, router, t.txid, hackers, {
      tx,
      spendingAddress: address,
      spendingHop: hop,
    });
  }
}

export async function runSeedPublicHackers(store: Store, seedFilePath: string): Promise<void> {
  const raw = await readFile(path.resolve(seedFilePath), "utf8");
  const data = JSON.parse(raw) as { hackers: Array<{ address: string; label?: string; source_url?: string }> };
  let delay = 0;
  for (const h of data.hackers) {
    store.upsertAddress({
      address: h.address,
      role: "hacker",
      label: h.label ?? null,
      source: "public_seed",
      isFlaggedHacker: true,
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    store.enqueueJob(
      "backfill_hacker_address",
      { address: h.address },
      JOB_PRIORITY.BACKFILL_HACKER,
      new Date(Date.now() + delay * 1000).toISOString(),
    );
    delay += 5;
  }
}

export async function runLoadLocalWatchlist(store: Store, localPath: string): Promise<void> {
  try {
    const raw = await readFile(path.resolve(localPath), "utf8");
    const data = JSON.parse(raw) as { hackers: Array<{ address: string; label?: string }> };
    for (const h of data.hackers) {
      const existing = store.getAddress(h.address);
      store.upsertAddress({
        address: h.address,
        role: "hacker",
        label: h.label ?? null,
        source: "local_config",
        isFlaggedHacker: true,
        hopFromHacker: 0,
      });
      if (!existing) {
        store.enqueueJob("backfill_hacker_address", { address: h.address }, JOB_PRIORITY.BACKFILL_HACKER);
      }
    }
  } catch {
    console.warn("No local watchlist found at", localPath);
  }
}

export async function runReBackfillHackers(store: Store): Promise<number> {
  const hackers = store.listHackers();
  let delay = 0;
  for (const h of hackers) {
    store.setExpandStatus(h.address, "pending");
    store.upsertBackfillState(h.address, null, false);
    store.enqueueJob(
      "backfill_hacker_address",
      { address: h.address },
      JOB_PRIORITY.BACKFILL_HACKER,
      new Date(Date.now() + delay * 1000).toISOString(),
    );
    delay += 5;
  }
  return hackers.length;
}

export async function runRebuildHackEdges(store: Store, config: AppConfig): Promise<number> {
  const txids = store.listIndexedTxids();
  store.deleteHackTraceEdges();
  store.resetHackerTotalReceived();
  const priority = processTxPriority(store, config);
  let delay = 0;
  for (const txid of txids) {
    store.enqueueJob(
      "process_tx",
      { txid },
      priority,
      new Date(Date.now() + delay * 1000).toISOString(),
    );
    delay += 3;
  }
  return txids.length;
}

export async function runRebuildHackEdgesWait(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
): Promise<number> {
  const total = await runRebuildHackEdges(store, config);
  console.log(`Processing ${total} transaction(s)...`);
  let processed = 0;
  while (store.countActiveJobs("process_tx") > 0) {
    const n = await processJobs(store, router, config);
    processed += n;
    if (processed > 0 && processed % 25 === 0) {
      const remaining = store.countActiveJobs("process_tx");
      console.log(`Rebuild progress: ${processed} jobs processed, ${remaining} remaining`);
    }
    if (n === 0) await new Promise((r) => setTimeout(r, 500));
  }
  store.recalcAllTotalReceived();
  console.log(`Rebuild complete: ${processed} jobs processed`);
  return total;
}

function parseBackfillPayload(raw: Record<string, unknown>): BackfillPayload {
  return {
    address: raw.address as string,
    chainCursor: raw.chainCursor as string | undefined,
    pendingTxids: raw.pendingTxids as string[] | undefined,
    processedIndex: raw.processedIndex as number | undefined,
    pagesExhausted: raw.pagesExhausted as boolean | undefined,
    newestTxid: raw.newestTxid as string | undefined,
    newestBlockHeight: raw.newestBlockHeight as number | null | undefined,
  };
}

function hydrateBackfillPayload(store: Store, rawPayload: Record<string, unknown>): BackfillPayload {
  const parsed = parseBackfillPayload(rawPayload);
  const hasContinuation =
    parsed.chainCursor != null ||
    (parsed.pendingTxids != null && parsed.pendingTxids.length > 0) ||
    parsed.pagesExhausted === true ||
    parsed.newestTxid != null;
  if (hasContinuation) return parsed;

  const saved = store.getBackfillState(parsed.address);
  if (saved?.payload) {
    return parseBackfillPayload({ address: parsed.address, ...saved.payload });
  }
  return parsed;
}

export function buildBackfillJobPayload(
  store: Store,
  address: string,
): Record<string, unknown> {
  const saved = store.getBackfillState(address);
  if (saved?.payload) {
    return { address, ...saved.payload };
  }
  return { address };
}

function toPersistedPayload(payload: BackfillPayload): Record<string, unknown> {
  return {
    address: payload.address,
    chainCursor: payload.chainCursor,
    pendingTxids: payload.pendingTxids,
    processedIndex: payload.processedIndex,
    pagesExhausted: payload.pagesExhausted,
    newestTxid: payload.newestTxid,
    newestBlockHeight: payload.newestBlockHeight,
  };
}

async function backfillHacker(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  rawPayload: Record<string, unknown>,
): Promise<void> {
  const payload = hydrateBackfillPayload(store, rawPayload);
  const address = payload.address;
  let pendingTxids = payload.pendingTxids ?? [];
  let processedIndex = payload.processedIndex ?? 0;
  let chainCursor = payload.chainCursor;
  let pagesExhausted = payload.pagesExhausted ?? false;
  let newestTxid = payload.newestTxid;
  let newestBlockHeight = payload.newestBlockHeight ?? null;

  const hackers = getHackerAddressSet(store);
  store.setExpandStatus(address, "backfilling");

  if (processedIndex >= pendingTxids.length && !pagesExhausted) {
    const { txs } = await router.fetchAddressTxPage(address, chainCursor);
    if (txs.length === 0) {
      pagesExhausted = true;
    } else {
      if (!newestTxid) {
        newestTxid = txs[0]!.txid;
        newestBlockHeight = txs[0]!.status?.block_height ?? null;
      }
      pendingTxids = [...txs].reverse().map((t) => t.txid);
      processedIndex = 0;
      chainCursor = txs[txs.length - 1]!.txid;
    }
  }

  let processed = 0;
  while (processedIndex < pendingTxids.length && processed < config.backfillTxsPerJob) {
    const txid = pendingTxids[processedIndex]!;
    processedIndex++;
    if (store.getTransaction(txid)) continue;
    await processTxForHackTrace(store, router, txid, hackers);
    processed++;
  }

  const hasPending = processedIndex < pendingTxids.length;
  const needsMore = hasPending || !pagesExhausted;

  const currentPayload: BackfillPayload = {
    address,
    chainCursor,
    pendingTxids: hasPending ? pendingTxids : [],
    processedIndex: hasPending ? processedIndex : 0,
    pagesExhausted,
    newestTxid,
    newestBlockHeight,
  };

  if (needsMore) {
    store.upsertBackfillState(address, toPersistedPayload(currentPayload), false);
    store.enqueueJob(
      "backfill_hacker_address",
      toPersistedPayload(currentPayload),
      JOB_PRIORITY.BACKFILL_HACKER,
    );
    return;
  }

  if (newestTxid) {
    store.upsertSyncState(address, {
      lastSeenTxid: newestTxid,
      lastBlockHeight: newestBlockHeight,
    });
  }
  store.upsertBackfillState(address, null, true);
  store.setExpandStatus(address, "expanded");
}

async function auditHackerBackfill(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  address: string,
): Promise<void> {
  const stats = await router.withProvider((p) => p.getAddressStats(address));
  const chainTxCount = stats.chain_stats.tx_count;
  const indexedTxs = store.countIndexedTxsForHacker(address);
  store.updateBackfillAudit(address, chainTxCount);

  if (chainTxCount > indexedTxs + config.backfillHealTxSlack) {
    store.setExpandStatus(address, "backfilling");
    store.upsertBackfillState(address, null, false);
    store.enqueueJob(
      "backfill_hacker_address",
      buildBackfillJobPayload(store, address),
      JOB_PRIORITY.BACKFILL_HACKER,
    );
  } else {
    store.upsertBackfillState(address, null, true);
  }
}

async function pollHacker(store: Store, router: ChainRouter, address: string): Promise<void> {
  const sync = store.getSyncState(address);
  const txs = await router.withProvider((p) => p.getAddressTxs(address, sync?.lastSeenTxid ?? undefined));
  const hackers = getHackerAddressSet(store);
  for (const t of txs.reverse()) {
    await processTxForHackTrace(store, router, t.txid, hackers);
  }
  if (txs.length > 0) {
    store.upsertSyncState(address, {
      lastSeenTxid: txs[0]!.txid,
      lastBlockHeight: txs[0]!.status?.block_height ?? null,
    });
  }
}

async function pollDownstream(store: Store, router: ChainRouter, address: string): Promise<void> {
  const addr = store.getAddress(address);
  const hop = addr?.hopFromHacker ?? 0;
  const sync = store.getSyncState(address);
  const txs = await router.withProvider((p) => p.getAddressTxs(address, sync?.lastSeenTxid ?? undefined));
  const hackers = getHackerAddressSet(store);
  await processAddressTxs(store, router, address, txs, hackers, hop);
  if (txs.length > 0) {
    store.upsertSyncState(address, {
      lastSeenTxid: txs[0]!.txid,
      lastBlockHeight: txs[0]!.status?.block_height ?? null,
    });
  }
}

async function expandDownstream(
  store: Store,
  router: ChainRouter,
  address: string,
  config: AppConfig,
): Promise<void> {
  const addr = store.getAddress(address);
  const hop = addr?.hopFromHacker ?? 0;
  const hackers = getHackerAddressSet(store);
  const txs = await router.fetchAddressTxsAll(address, config.backfillMaxTxs);
  await processAddressTxs(store, router, address, txs, hackers, hop);
  store.setExpandStatus(address, "expanded");

  if (txs.length > 0) {
    store.upsertSyncState(address, {
      lastSeenTxid: txs[0]!.txid,
      lastBlockHeight: txs[0]!.status?.block_height ?? null,
    });
  }

  if ((hop ?? 0) + 1 >= config.maxCrawlDepth) {
    for (const e of store.getEdgesFromAddress(address)) {
      store.upsertAddress({
        address: e.toAddress,
        expandStatus: "max_depth",
      });
    }
  }
}

async function refreshBalance(store: Store, router: ChainRouter, address: string): Promise<void> {
  const stats = await router.withProvider((p) => p.getAddressStats(address));
  const funded = stats.chain_stats.funded_txo_sum + (stats.mempool_stats?.funded_txo_sum ?? 0);
  const spent = stats.chain_stats.spent_txo_sum + (stats.mempool_stats?.spent_txo_sum ?? 0);
  store.upsertAddress({
    address,
    liveBalanceSats: funded - spent,
    liveBalanceAt: new Date().toISOString(),
  });
}

async function syncColdcardwatch(store: Store, config: AppConfig): Promise<void> {
  const data = await fetchColdcardWatch(config.coldcardwatchBase);
  const prev = store.getSourceSync("coldcardwatch");
  if (prev?.lastContentHash === data.contentHash) return;
  applyColdcardWatchSync(store, data);
}

async function syncVercelTrackers(store: Store, config: AppConfig): Promise<void> {
  const [hackData, sweepData] = await Promise.all([
    fetchColdcardHackTracker(config.coldcardHackTrackerBase),
    fetchColdcardSweepWatch(config.coldcardSweepWatchBase),
  ]);

  const prevHack = store.getSourceSync("coldcard_hack_tracker");
  const prevSweep = store.getSourceSync("coldcard_sweep_watch");
  const hackUnchanged = prevHack?.lastContentHash === hackData.contentHash;
  const sweepUnchanged = prevSweep?.lastContentHash === sweepData.contentHash;
  if (hackUnchanged && sweepUnchanged) return;

  if (!hackUnchanged) applyColdcardHackTrackerSync(store, hackData);
  if (!sweepUnchanged) applyColdcardSweepWatchSync(store, sweepData);
}

export async function processJob(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  job: Job,
): Promise<void> {
  const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
  switch (job.type) {
    case "seed_public_hackers":
      await runSeedPublicHackers(store, config.seedFilePath);
      break;
    case "backfill_hacker_address":
      await backfillHacker(store, router, config, payload);
      break;
    case "audit_hacker_backfill":
      await auditHackerBackfill(store, router, config, payload.address as string);
      break;
    case "poll_hacker_address":
      await pollHacker(store, router, payload.address as string);
      break;
    case "poll_downstream_address":
      await pollDownstream(store, router, payload.address as string);
      break;
    case "expand_downstream":
      await expandDownstream(store, router, payload.address as string, config);
      break;
    case "refresh_live_balance":
      await refreshBalance(store, router, payload.address as string);
      break;
    case "refresh_btc_usd_price": {
      const { usd, at } = await fetchMempoolBtcUsd(config.mempoolBase);
      store.setBtcUsdPrice(usd, at);
      break;
    }
    case "sync_coldcardwatch":
      await syncColdcardwatch(store, config);
      break;
    case "sync_vercel_trackers":
      await syncVercelTrackers(store, config);
      break;
    case "process_tx":
      await processTxForHackTrace(store, router, payload.txid as string, getHackerAddressSet(store));
      break;
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

export async function processJobs(store: Store, router: ChainRouter, config: AppConfig): Promise<number> {
  let processed = 0;
  for (let i = 0; i < config.jobsPerTick; i++) {
    const job = store.claimNextJob();
    if (!job) break;
    try {
      if (job.type === "sync_coldcardwatch") {
        await syncColdcardwatch(store, config);
      } else if (job.type === "sync_vercel_trackers") {
        await syncVercelTrackers(store, config);
      } else {
        await processJob(store, router, config, job);
      }
      store.completeJob(job.id);
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const backoff = Math.min(300, 30 * (job.attempts + 1));
      store.failJob(job.id, message, new Date(Date.now() + backoff * 1000).toISOString());
    }
  }
  return processed;
}
