import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Job, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import { ChainRouter, RateLimitNotReadyError } from "../chain/router.js";
import { txInvolvesSpend, isRateLimitError, isTransientFetchError } from "../chain/esplora.js";
import { getHackerAddressSet, processTxForHackTrace } from "../graph/builder.js";
import { applyColdcardWatchSync, fetchColdcardWatch } from "../sources/coldcardwatch.js";
import {
  applyColdcardHackTrackerSync,
  fetchColdcardHackTracker,
} from "../sources/coldcardHackTracker.js";
import { applyColdcardSweepWatchSync, fetchColdcardSweepWatch } from "../sources/coldcardSweepWatch.js";
import { fetchMempoolBtcUsd } from "../price/mempoolPrices.js";
import { normalizeBitcoinAddress } from "../util/address.js";
import { logJobDefer, logJobDone, logJobFail, logJobStart } from "./jobLog.js";
import { isIngestJobType } from "./jobClass.js";
import { processTxPriority } from "./rebuildMode.js";

async function readJsonText(filePath: string, inlineJson: string | null | undefined): Promise<string> {
  if (inlineJson?.trim()) return inlineJson;
  return readFile(path.resolve(filePath), "utf8");
}

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
    if (await store.getTransaction(t.txid)) continue;
    const tx = await router.withProvider((p) => p.getTx(t.txid));
    if (!txInvolvesSpend(tx, address)) continue;
    await processTxForHackTrace(store, router, t.txid, hackers, {
      tx,
      spendingAddress: address,
      spendingHop: hop,
    });
  }
}

export async function runSeedPublicHackers(
  store: Store,
  seedFilePath: string,
  seedDataJson?: string | null,
): Promise<void> {
  const raw = await readJsonText(seedFilePath, seedDataJson);
  const data = JSON.parse(raw) as { hackers: Array<{ address: string; label?: string; source_url?: string }> };
  let delay = 0;
  for (const h of data.hackers) {
    const address = normalizeBitcoinAddress(h.address);
    if (!address) {
      console.warn(`Skipping invalid seed hacker address: ${h.address}`);
      continue;
    }
    await store.upsertAddress({
      address,
      role: "hacker",
      label: h.label ?? null,
      source: "public_seed",
      isFlaggedHacker: true,
      hopFromHacker: 0,
      expandStatus: "pending",
    });
    await store.enqueueJob(
      "backfill_hacker_address",
      { address },
      JOB_PRIORITY.BACKFILL_HACKER,
      new Date(Date.now() + delay * 1000).toISOString(),
    );
    delay += 5;
  }
}

export async function runLoadLocalWatchlist(
  store: Store,
  localPath: string,
  localWatchlistDataJson?: string | null,
): Promise<void> {
  try {
    const raw = await readJsonText(localPath, localWatchlistDataJson);
    const data = JSON.parse(raw) as { hackers: Array<{ address: string; label?: string }> };
    for (const h of data.hackers) {
      const address = normalizeBitcoinAddress(h.address);
      if (!address) {
        console.warn(`Skipping invalid local watchlist hacker address: ${h.address}`);
        continue;
      }
      const existing = await store.getAddress(address);
      await store.upsertAddress({
        address,
        role: "hacker",
        label: h.label ?? null,
        source: "local_config",
        isFlaggedHacker: true,
        hopFromHacker: 0,
      });
      if (!existing) {
        await store.enqueueJob("backfill_hacker_address", { address }, JOB_PRIORITY.BACKFILL_HACKER);
      }
    }
  } catch {
    console.warn("No local watchlist found at", localPath);
  }
}

export async function runReBackfillHackers(
  store: Store,
  opts?: { fresh?: boolean },
): Promise<number> {
  const hackers = await store.listHackers();
  let delay = 0;
  let queued = 0;
  for (const h of hackers) {
    const saved = await store.getBackfillState(h.address);

    if (!opts?.fresh && saved?.backfillComplete) continue;

    let payload: Record<string, unknown>;
    if (opts?.fresh) {
      await runReBackfillHacker(store, h.address);
      payload = { address: h.address };
    } else if (hasResumableBackfillState(saved)) {
      payload = await buildBackfillJobPayload(store, h.address);
      await store.setExpandStatus(h.address, "backfilling");
    } else {
      await runReBackfillHacker(store, h.address);
      payload = { address: h.address };
    }

    await store.enqueueJob(
      "backfill_hacker_address",
      payload,
      JOB_PRIORITY.BACKFILL_HACKER,
      new Date(Date.now() + delay * 1000).toISOString(),
    );
    delay += 5;
    queued++;
  }
  return queued;
}

export async function runReBackfillHacker(store: Store, address: string): Promise<string> {
  await store.setExpandStatus(address, "pending");
  await store.upsertBackfillState(address, null, false);
  return address;
}

export async function runRebuildHackEdges(store: Store, config: AppConfig): Promise<number> {
  const txids = await store.listIndexedTxids();
  await store.deleteHackTraceEdges();
  await store.resetHackerTotalReceived();
  const priority = await processTxPriority(store, config);
  let delay = 0;
  for (const txid of txids) {
    await store.enqueueJob(
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
  while ((await store.countActiveJobs("process_tx")) > 0) {
    const n = await processJobs(store, router, config);
    processed += n;
    if (processed > 0 && processed % 25 === 0) {
      const remaining = await store.countActiveJobs("process_tx");
      console.log(`Rebuild progress: ${processed} jobs processed, ${remaining} remaining`);
    }
    if (n === 0) await new Promise((r) => setTimeout(r, 500));
  }
  await store.recalcAllTotalReceived();
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

export function hasResumableBackfillState(
  saved: { payload: Record<string, unknown> | null; backfillComplete: boolean } | null,
): boolean {
  if (!saved || saved.backfillComplete || !saved.payload) return false;
  const p = saved.payload;
  return (
    p.chainCursor != null ||
    (Array.isArray(p.pendingTxids) && p.pendingTxids.length > 0) ||
    p.pagesExhausted === true ||
    p.newestTxid != null
  );
}

async function hydrateBackfillPayload(store: Store, rawPayload: Record<string, unknown>): Promise<BackfillPayload> {
  const parsed = parseBackfillPayload(rawPayload);
  const hasContinuation =
    parsed.chainCursor != null ||
    (parsed.pendingTxids != null && parsed.pendingTxids.length > 0) ||
    parsed.pagesExhausted === true ||
    parsed.newestTxid != null;
  if (hasContinuation) return parsed;

  const saved = await store.getBackfillState(parsed.address);
  if (saved?.payload) {
    return parseBackfillPayload({ address: parsed.address, ...saved.payload });
  }
  return parsed;
}

export async function buildBackfillJobPayload(
  store: Store,
  address: string,
): Promise<Record<string, unknown>> {
  const saved = await store.getBackfillState(address);
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
  options?: { enqueueContinuation?: boolean },
): Promise<void> {
  const enqueueContinuation = options?.enqueueContinuation !== false;
  const payload = await hydrateBackfillPayload(store, rawPayload);
  const address = payload.address;
  let pendingTxids = payload.pendingTxids ?? [];
  let processedIndex = payload.processedIndex ?? 0;
  let chainCursor = payload.chainCursor;
  let pagesExhausted = payload.pagesExhausted ?? false;
  let newestTxid = payload.newestTxid;
  let newestBlockHeight = payload.newestBlockHeight ?? null;

  const hackers = await getHackerAddressSet(store);
  await store.setExpandStatus(address, "backfilling");

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
    if (await store.getTransaction(txid)) continue;
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
    await store.upsertBackfillState(address, toPersistedPayload(currentPayload), false);
    if (enqueueContinuation) {
      await store.enqueueJob(
        "backfill_hacker_address",
        toPersistedPayload(currentPayload),
        JOB_PRIORITY.BACKFILL_HACKER,
      );
    }
    return;
  }

  if (newestTxid) {
    await store.upsertSyncState(address, {
      lastSeenTxid: newestTxid,
      lastBlockHeight: newestBlockHeight,
    });
  }
  await store.upsertBackfillState(address, null, true);
  await store.setExpandStatus(address, "expanded");
}

function rateLimitBackoffMs(err: unknown): number {
  if (!(err instanceof Error)) return 60_000;
  const match = err.message.match(/retry-after[:\s]+(\d+)/i);
  if (match) return Math.max(1000, Number(match[1]) * 1000);
  return 60_000;
}

export async function runReBackfillHackerWait(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  address: string,
  opts?: { fresh?: boolean },
): Promise<void> {
  const existing = await store.getBackfillState(address);
  const resume = !opts?.fresh && hasResumableBackfillState(existing);
  if (!resume) {
    await runReBackfillHacker(store, address);
  } else {
    console.log(`Resuming incomplete backfill for ${address}...`);
  }
  console.log(`Backfilling ${address}...`);
  let iterations = 0;
  while (true) {
    try {
      await backfillHacker(store, router, config, { address }, { enqueueContinuation: false });
    } catch (err) {
      if (isRateLimitError(err)) {
        const waitMs = rateLimitBackoffMs(err);
        console.warn(
          `Rate limited during backfill, retrying in ${waitMs / 1000}s: ${err instanceof Error ? err.message : err}`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!isTransientFetchError(err)) throw err;
      console.warn(`Network error during backfill, retrying in 10s: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    const backfill = await store.getBackfillState(address);
    const addrAfter = await store.getAddress(address);
    if (backfill?.backfillComplete) {
      if (addrAfter?.expandStatus !== "expanded") {
        await store.setExpandStatus(address, "expanded");
      }
      break;
    }
    iterations++;
    if (iterations % 25 === 0) {
      console.log(`Backfill progress: ${iterations} iteration(s)`);
    }
  }
  await store.recalcTotalReceived(address);
  const indexed = await store.countIndexedTxsForHacker(address);
  console.log(`Backfill complete for ${address}: ${indexed} indexed transaction(s)`);
}

export async function runReBackfillHackersWait(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  opts?: { fresh?: boolean },
): Promise<number> {
  const hackers = await store.listHackers();
  let done = 0;
  for (const h of hackers) {
    if (!opts?.fresh) {
      const saved = await store.getBackfillState(h.address);
      if (saved?.backfillComplete) {
        console.log(`Skipping ${h.address} (backfill complete)`);
        continue;
      }
    }
    console.log(`--- Hacker ${done + 1}: ${h.address} ---`);
    await runReBackfillHackerWait(store, router, config, h.address, { fresh: opts?.fresh });
    done++;
  }
  return done;
}

async function auditHackerBackfill(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  address: string,
): Promise<void> {
  const stats = await router.withProvider((p) => p.getAddressStats(address));
  const chainTxCount = stats.chain_stats.tx_count;
  const indexedTxs = await store.countIndexedTxsForHacker(address);
  await store.updateBackfillAudit(address, chainTxCount);

  if (chainTxCount > indexedTxs + config.backfillHealTxSlack) {
    await store.setExpandStatus(address, "backfilling");
    await store.upsertBackfillState(address, null, false);
    await store.enqueueJob(
      "backfill_hacker_address",
      await buildBackfillJobPayload(store, address),
      JOB_PRIORITY.BACKFILL_HACKER,
    );
  } else {
    await store.upsertBackfillState(address, null, true);
  }
}

async function pollHacker(store: Store, router: ChainRouter, address: string): Promise<void> {
  const sync = await store.getSyncState(address);
  const txs = await router.withProvider((p) => p.getAddressTxs(address, sync?.lastSeenTxid ?? undefined));
  const hackers = await getHackerAddressSet(store);
  for (const t of txs.reverse()) {
    await processTxForHackTrace(store, router, t.txid, hackers);
  }
  if (txs.length > 0) {
    await store.upsertSyncState(address, {
      lastSeenTxid: txs[0]!.txid,
      lastBlockHeight: txs[0]!.status?.block_height ?? null,
    });
  } else {
    await store.touchSyncPoll(address);
  }
}

async function pollDownstream(store: Store, router: ChainRouter, address: string): Promise<void> {
  const addr = await store.getAddress(address);
  const hop = addr?.hopFromHacker ?? 0;
  const sync = await store.getSyncState(address);
  const txs = await router.withProvider((p) => p.getAddressTxs(address, sync?.lastSeenTxid ?? undefined));
  const hackers = await getHackerAddressSet(store);
  await processAddressTxs(store, router, address, txs, hackers, hop);
  if (txs.length > 0) {
    await store.upsertSyncState(address, {
      lastSeenTxid: txs[0]!.txid,
      lastBlockHeight: txs[0]!.status?.block_height ?? null,
    });
  } else {
    await store.touchSyncPoll(address);
  }
}

interface ExpandPayload {
  address: string;
  chainCursor?: string;
  pendingTxids?: string[];
  processedIndex?: number;
  pagesExhausted?: boolean;
  newestTxid?: string;
  newestBlockHeight?: number | null;
  pagesFetched?: number;
}

/** Chunked expand: paginate address txs and process up to backfillTxsPerJob per job tick. */
async function expandDownstream(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  rawPayload: Record<string, unknown>,
): Promise<void> {
  const address = rawPayload.address as string;
  let pendingTxids = (rawPayload.pendingTxids as string[] | undefined) ?? [];
  let processedIndex = (rawPayload.processedIndex as number | undefined) ?? 0;
  let chainCursor = rawPayload.chainCursor as string | undefined;
  let pagesExhausted = (rawPayload.pagesExhausted as boolean | undefined) ?? false;
  let newestTxid = rawPayload.newestTxid as string | undefined;
  let newestBlockHeight = (rawPayload.newestBlockHeight as number | null | undefined) ?? null;
  let pagesFetched = (rawPayload.pagesFetched as number | undefined) ?? 0;

  const addr = await store.getAddress(address);
  const hop = addr?.hopFromHacker ?? 0;
  const hackers = await getHackerAddressSet(store);
  await store.setExpandStatus(address, "expanding");

  const maxPages = Math.max(1, Math.ceil(config.backfillMaxTxs / 25));

  if (processedIndex >= pendingTxids.length && !pagesExhausted && pagesFetched < maxPages) {
    const { txs } = await router.fetchAddressTxPage(address, chainCursor);
    pagesFetched++;
    if (txs.length === 0) {
      pagesExhausted = true;
    } else {
      if (!newestTxid) {
        newestTxid = txs[0]!.txid;
        newestBlockHeight = txs[0]!.status?.block_height ?? null;
      }
      pendingTxids = txs.map((t) => t.txid);
      processedIndex = 0;
      chainCursor = txs[txs.length - 1]!.txid;
      if (pagesFetched * 25 >= config.backfillMaxTxs) pagesExhausted = true;
    }
  } else if (pagesFetched >= maxPages) {
    pagesExhausted = true;
  }

  let processed = 0;
  const batch: Array<{ txid: string }> = [];
  while (processedIndex < pendingTxids.length && processed < config.backfillTxsPerJob) {
    batch.push({ txid: pendingTxids[processedIndex]! });
    processedIndex++;
    processed++;
  }
  if (batch.length > 0) {
    await processAddressTxs(store, router, address, batch, hackers, hop);
  }

  const hasPending = processedIndex < pendingTxids.length;
  const needsMore = hasPending || !pagesExhausted;

  const nextPayload: ExpandPayload = {
    address,
    chainCursor,
    pendingTxids: hasPending ? pendingTxids : [],
    processedIndex: hasPending ? processedIndex : 0,
    pagesExhausted,
    newestTxid,
    newestBlockHeight,
    pagesFetched,
  };

  if (needsMore) {
    await store.enqueueJob(
      "expand_downstream",
      nextPayload as unknown as Record<string, unknown>,
      JOB_PRIORITY.CRON_EXPAND,
    );
    return;
  }

  await store.setExpandStatus(address, "expanded");
  if (newestTxid) {
    await store.upsertSyncState(address, {
      lastSeenTxid: newestTxid,
      lastBlockHeight: newestBlockHeight,
    });
  }

  if ((hop ?? 0) + 1 >= config.maxCrawlDepth) {
    for (const e of await store.getEdgesFromAddress(address)) {
      await store.upsertAddress({
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
  await store.upsertAddress({
    address,
    liveBalanceSats: funded - spent,
    liveBalanceAt: new Date().toISOString(),
  });
}

async function syncColdcardwatch(store: Store, config: AppConfig): Promise<void> {
  const data = await fetchColdcardWatch(config.coldcardwatchBase);
  const prev = await store.getSourceSync("coldcardwatch");
  if (prev?.lastContentHash === data.contentHash) return;
  await applyColdcardWatchSync(store, data);
}

async function syncVercelTrackers(store: Store, config: AppConfig): Promise<void> {
  const [hackData, sweepData] = await Promise.all([
    fetchColdcardHackTracker(config.coldcardHackTrackerBase),
    fetchColdcardSweepWatch(config.coldcardSweepWatchBase),
  ]);

  const prevHack = await store.getSourceSync("coldcard_hack_tracker");
  const prevSweep = await store.getSourceSync("coldcard_sweep_watch");
  const hackUnchanged = prevHack?.lastContentHash === hackData.contentHash;
  const sweepUnchanged = prevSweep?.lastContentHash === sweepData.contentHash;
  if (hackUnchanged && sweepUnchanged) return;

  if (!hackUnchanged) await applyColdcardHackTrackerSync(store, hackData);
  if (!sweepUnchanged) await applyColdcardSweepWatchSync(store, sweepData);
}

export async function processJob(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  job: Job,
): Promise<void> {
  const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
  switch (job.type) {
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
      await expandDownstream(store, router, config, payload);
      break;
    case "refresh_live_balance":
      await refreshBalance(store, router, payload.address as string);
      break;
    case "refresh_btc_usd_price": {
      const { usd, at } = await fetchMempoolBtcUsd(config.mempoolBase);
      await store.setBtcUsdPrice(usd, at);
      break;
    }
    case "sync_coldcardwatch":
      await syncColdcardwatch(store, config);
      break;
    case "sync_vercel_trackers":
      await syncVercelTrackers(store, config);
      break;
    case "process_tx":
      await processTxForHackTrace(store, router, payload.txid as string, await getHackerAddressSet(store));
      break;
    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }
}

function formatJobDurationMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec >= 10) return `${Math.round(totalSec)}s`;
  return `${Math.round(totalSec * 10) / 10}s`;
}

function jobDurationMs(job: Job): number | null {
  if (!job.startedAt) return null;
  const startMs = new Date(job.startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  const durationMs = Date.now() - startMs;
  return durationMs >= 0 ? durationMs : null;
}

/** Handle job failure: log, defer or fail, return whether to stop claiming more jobs this tick. */
export async function handleJobFailure(
  store: Store,
  config: AppConfig,
  job: Job,
  err: unknown,
  logColor = false,
): Promise<boolean> {
  const attempt = job.attempts + 1;
  logJobFail(job, err, { attempt, color: logColor });

  if (err instanceof RateLimitNotReadyError) {
    if (isIngestJobType(job.type) && attempt >= config.jobDeferAfterAttempts) {
      const runAfter = new Date(Date.now() + config.jobDeferSec * 1000).toISOString();
      await store.deferJob(job.id, err.message, runAfter);
      logJobDefer(job, { attempt, deferSec: config.jobDeferSec, runAfter, color: logColor });
    } else {
      await store.failJob(job.id, err.message, err.retryAt);
    }
    return true;
  }

  const message = err instanceof Error ? err.message : String(err);
  if (isRateLimitError(err)) {
    const retryAt =
      (await store.earliestProviderRetryAt()) ??
      new Date(Date.now() + config.apiThresholdBaseSec * 1000).toISOString();
    await store.failJob(job.id, message, retryAt);
    return true;
  }

  const backoff = Math.min(300, 30 * attempt);
  await store.failJob(job.id, message, new Date(Date.now() + backoff * 1000).toISOString());
  return false;
}

export async function processJobs(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  opts?: { deadlineMs?: number; jobDetails?: boolean; logColor?: boolean },
): Promise<number> {
  const jobDetails = opts?.jobDetails ?? false;
  const logColor = opts?.logColor ?? false;
  let processed = 0;
  for (let i = 0; i < config.jobsPerTick; i++) {
    if (opts?.deadlineMs != null && Date.now() >= opts.deadlineMs) break;
    const job =
      (await store.claimNextIngestJob({ preferContinuation: true })) ?? (await store.claimNextJob());
    if (!job) break;
    if (jobDetails) {
      logJobStart(job, { color: logColor });
    }
    try {
      if (job.type === "sync_coldcardwatch") {
        await syncColdcardwatch(store, config);
      } else if (job.type === "sync_vercel_trackers") {
        await syncVercelTrackers(store, config);
      } else {
        await processJob(store, router, config, job);
      }
      await store.completeJob(job.id);
      await store.maybeClearQueueSchedulingPause();
      processed++;
      const queueDepth = await store.getQueueDepth();
      logJobDone(job, formatJobDurationMs(jobDurationMs(job)), queueDepth, { color: logColor });
    } catch (err) {
      if (await handleJobFailure(store, config, job, err, logColor)) break;
    }
  }
  return processed;
}
