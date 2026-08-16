import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Job, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import { ChainRouter, RateLimitNotReadyError } from "../chain/router.js";
import { isRateLimitError, isTransientFetchError } from "../chain/esplora.js";
import { getHackerAddressSet, processTxForHackTrace } from "../graph/builder.js";
import { applyColdcardWatchSync, applyColdcardWatchSyncBatch, enqueueColdcardWatchBatchJobs, fetchColdcardWatch } from "../sources/coldcardwatch.js";
import {
  applyColdcardHackTrackerSync,
  applyColdcardHackTrackerSyncBatch,
  enqueueColdcardHackTrackerBatchJobs,
  fetchColdcardHackTracker,
} from "../sources/coldcardHackTracker.js";
import {
  applyColdcardSweepWatchSync,
  applyColdcardSweepWatchSyncBatch,
  enqueueColdcardSweepWatchBatchJobs,
  fetchColdcardSweepWatch,
} from "../sources/coldcardSweepWatch.js";
import { fetchMempoolBtcUsd } from "../price/mempoolPrices.js";
import { normalizeBitcoinAddress } from "../util/address.js";
import { logJobDefer, logJobDone, logJobFail, logJobStart } from "./jobLog.js";
import { isIngestJobType } from "./jobClass.js";
import { processTxPriority } from "./rebuildMode.js";
import { createChainCallBudget } from "./chainCallBudget.js";
import { createCpuGuardFromConfig, type CpuGuard } from "./cpuGuard.js";
import { createJobSubrequestBudget, type JobSubrequestBudget, type SubrequestBudget } from "./subrequestBudget.js";
import type { HackTraceEdgeDraft } from "../graph/builder.js";
import type { JobRunStats, TickStopReason } from "./tickStats.js";
import {
  collectSpendTargetsFromRuntime,
  pendingFromPageTxs,
  readPendingRuntime,
  writePendingPayload,
  type PendingPayloadFields,
} from "./pendingPayload.js";
import { detectSweepRelay } from "./sweepRelay.js";
import { processClassifiedPendingTx, type TraceProcessState } from "./txProcess.js";
import type { PendingTxRuntime } from "./txPage.js";

export interface ProcessJobsResult {
  processed: number;
  stopReason: TickStopReason;
}

function jobStatsFromTrace(
  traceResult: {
    traceComplete: boolean;
    nextEdgeIndex: number;
    edgesApplied: number;
    traceEdgeTotal: number;
  },
  continued: boolean,
  cpuGuardTripped?: boolean,
): JobRunStats {
  return {
    continued,
    traceEdgeIndex: traceResult.nextEdgeIndex,
    traceEdgeTotal: traceResult.traceEdgeTotal,
    edgesApplied: traceResult.edgesApplied,
    cpuGuard: cpuGuardTripped === true ? true : undefined,
  };
}

async function readJsonText(filePath: string, inlineJson: string | null | undefined): Promise<string> {
  if (inlineJson?.trim()) return inlineJson;
  return readFile(path.resolve(filePath), "utf8");
}

export interface BackfillPayload extends PendingPayloadFields {
  address: string;
  chainCursor?: string;
  pagesExhausted?: boolean;
  newestTxid?: string;
  newestBlockHeight?: number | null;
  traceTxid?: string;
  traceEdgeIndex?: number;
  traceEdgesPending?: boolean;
  traceEdgeTotal?: number;
  traceEdgesFlat?: HackTraceEdgeDraft[];
}

function clearTraceFields(payload: BackfillPayload): BackfillPayload {
  return {
    ...payload,
    traceTxid: undefined,
    traceEdgeIndex: undefined,
    traceEdgesPending: undefined,
    traceEdgeTotal: undefined,
    traceEdgesFlat: undefined,
  };
}

function traceFieldsFromState(
  state: Pick<
    BackfillPayload,
    "traceTxid" | "traceEdgeIndex" | "traceEdgesPending" | "traceEdgeTotal" | "traceEdgesFlat"
  >,
): Pick<
  BackfillPayload,
  "traceTxid" | "traceEdgeIndex" | "traceEdgesPending" | "traceEdgeTotal" | "traceEdgesFlat"
> {
  return {
    traceTxid: state.traceTxid,
    traceEdgeIndex: state.traceEdgeIndex,
    traceEdgesPending: state.traceEdgesPending,
    traceEdgeTotal: state.traceEdgeTotal,
    traceEdgesFlat: state.traceEdgesFlat,
  };
}

async function processAddressTxs(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  address: string,
  txs: PendingTxRuntime[],
  hackers: Set<string>,
  hop: number,
  maxCalls?: number,
  tracePayload?: Pick<
    BackfillPayload,
    "traceTxid" | "traceEdgeIndex" | "traceEdgesPending" | "traceEdgeTotal" | "traceEdgesFlat"
  >,
  expandProfile?: string | null,
  cpuGuard?: CpuGuard,
): Promise<Pick<
  BackfillPayload,
  "traceTxid" | "traceEdgeIndex" | "traceEdgesPending" | "traceEdgeTotal" | "traceEdgesFlat"
> | null> {
  let calls = 0;
  let traceState: TraceProcessState = {
    traceTxid: tracePayload?.traceTxid,
    traceEdgeIndex: tracePayload?.traceEdgeIndex,
    traceEdgesPending: tracePayload?.traceEdgesPending,
    traceEdgeTotal: tracePayload?.traceEdgeTotal,
    traceEdgesFlat: tracePayload?.traceEdgesFlat,
  };
  for (const entry of txs) {
    if (maxCalls != null && calls >= maxCalls) break;
    if (cpuGuard?.exceeded()) break;
    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      hop,
      entry,
      hackers,
      traceState,
      { expandProfile, cpuGuard },
    );
    calls += result.chainCallsUsed;
    if (result.continued) {
      return traceFieldsFromState(result.traceState);
    }
    traceState = result.traceState;
  }
  return null;
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
    const { processed: n } = await processJobs(store, router, config);
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
  const { pending, processedIndex } = readPendingRuntime(raw);
  return {
    address: raw.address as string,
    chainCursor: raw.chainCursor as string | undefined,
    ...writePendingPayload(pending, processedIndex),
    pagesExhausted: raw.pagesExhausted as boolean | undefined,
    newestTxid: raw.newestTxid as string | undefined,
    newestBlockHeight: raw.newestBlockHeight as number | null | undefined,
    traceTxid: raw.traceTxid as string | undefined,
    traceEdgeIndex: raw.traceEdgeIndex as number | undefined,
    traceEdgesPending: raw.traceEdgesPending as boolean | undefined,
    traceEdgeTotal: raw.traceEdgeTotal as number | undefined,
    traceEdgesFlat: raw.traceEdgesFlat as HackTraceEdgeDraft[] | undefined,
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
    (Array.isArray(p.pendingTxs) && p.pendingTxs.length > 0) ||
    p.pagesExhausted === true ||
    p.newestTxid != null ||
    p.traceEdgesPending === true
  );
}

async function hydrateBackfillPayload(store: Store, rawPayload: Record<string, unknown>): Promise<BackfillPayload> {
  const parsed = parseBackfillPayload(rawPayload);
  const hasContinuation =
    parsed.chainCursor != null ||
    (parsed.pendingTxids != null && parsed.pendingTxids.length > 0) ||
    (parsed.pendingTxs != null && parsed.pendingTxs.length > 0) ||
    parsed.pagesExhausted === true ||
    parsed.newestTxid != null ||
    parsed.traceEdgesPending === true;
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
    pendingTxs: payload.pendingTxs,
    pendingTxids: payload.pendingTxids,
    processedIndex: payload.processedIndex,
    pagesExhausted: payload.pagesExhausted,
    newestTxid: payload.newestTxid,
    newestBlockHeight: payload.newestBlockHeight,
    traceTxid: payload.traceTxid,
    traceEdgeIndex: payload.traceEdgeIndex,
    traceEdgesPending: payload.traceEdgesPending,
    traceEdgeTotal: payload.traceEdgeTotal,
    traceEdgesFlat: payload.traceEdgesFlat,
  };
}

async function enqueueBackfillContinuation(
  store: Store,
  payload: BackfillPayload,
  enqueueContinuation: boolean,
): Promise<void> {
  await store.upsertBackfillState(payload.address, toPersistedPayload(payload), false);
  if (enqueueContinuation) {
    await store.enqueueJob(
      "backfill_hacker_address",
      toPersistedPayload(payload),
      JOB_PRIORITY.BACKFILL_HACKER,
    );
  }
}

async function backfillHacker(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  rawPayload: Record<string, unknown>,
  options?: {
    enqueueContinuation?: boolean;
    jobSubreq?: JobSubrequestBudget;
    hackers?: Set<string>;
    cpuGuard?: CpuGuard;
  },
): Promise<JobRunStats | undefined> {
  const enqueueContinuation = options?.enqueueContinuation !== false;
  const jobSubreq = options?.jobSubreq;
  const cpuGuard = options?.cpuGuard;
  const payload = await hydrateBackfillPayload(store, rawPayload);
  const address = payload.address;
  let pending = readPendingRuntime(payload as unknown as Record<string, unknown>).pending;
  let processedIndex = payload.processedIndex ?? 0;
  let chainCursor = payload.chainCursor;
  let pagesExhausted = payload.pagesExhausted ?? false;
  let newestTxid = payload.newestTxid;
  let newestBlockHeight = payload.newestBlockHeight ?? null;

  const hackers = options?.hackers ?? (await getHackerAddressSet(store));
  await store.setExpandStatus(address, "backfilling");

  const budget = createChainCallBudget(config.maxChainCallsPerJob);
  const limited = config.maxChainCallsPerJob > 0;
  const needsProcess = processedIndex < pending.length;
  const needsFetch = processedIndex >= pending.length && !pagesExhausted;

  if ((!limited || !needsProcess) && needsFetch && budget.canCall() && (!jobSubreq || jobSubreq.canUse())) {
    const { txs } = await router.fetchAddressTxPage(address, chainCursor);
    budget.consume();
    if (txs.length === 0) {
      pagesExhausted = true;
    } else {
      if (!newestTxid) {
        newestTxid = txs[0]!.txid;
        newestBlockHeight = txs[0]!.status?.block_height ?? null;
      }
      pending = pendingFromPageTxs([...txs].reverse(), address);
      processedIndex = 0;
      chainCursor = txs[txs.length - 1]!.txid;
    }
    if ((limited && budget.exhausted()) || jobSubreq?.exhausted()) {
      const hasPendingAfterFetch = processedIndex < pending.length;
      const needsMoreAfterFetch = hasPendingAfterFetch || !pagesExhausted;
      if (needsMoreAfterFetch) {
        await enqueueBackfillContinuation(
          store,
          {
            address,
            chainCursor,
            ...writePendingPayload(pending, processedIndex),
            pagesExhausted,
            newestTxid,
            newestBlockHeight,
          },
          enqueueContinuation,
        );
        return { continued: true };
      }
    }
  }

  const processLimit = limited
    ? budget.processBatchLimit(config.backfillTxsPerJob)
    : config.backfillTxsPerJob;
  let processed = 0;
  let traceTxid = payload.traceTxid;
  let traceEdgeIndex = payload.traceEdgeIndex;
  let traceEdgesPending = payload.traceEdgesPending;
  let traceEdgeTotal = payload.traceEdgeTotal;
  let traceEdgesFlat = payload.traceEdgesFlat;
  const addrRow = await store.getAddress(address);
  const expandProfile = addrRow?.expandProfile ?? null;
  let skippedReceives = 0;
  while (
    processedIndex < pending.length &&
    processed < processLimit &&
    budget.canCall() &&
    (!jobSubreq || jobSubreq.canUse()) &&
    !cpuGuard?.exceeded()
  ) {
    const entry = pending[processedIndex]!;
    const traceActiveOnEntry = traceEdgesPending === true && traceTxid === entry.txid;
    if (
      !traceActiveOnEntry &&
      entry.isSpend === false &&
      skippedReceives < config.backfillSkipReceivesPerJob
    ) {
      processedIndex++;
      skippedReceives++;
      continue;
    }

    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      0,
      entry,
      hackers,
      { traceTxid, traceEdgeIndex, traceEdgesPending, traceEdgeTotal, traceEdgesFlat },
      { expandProfile, cpuGuard },
    );
    if (result.chainCallsUsed > 0) budget.consume();
    processed++;
    if (result.continued) {
      const pendingPayload: BackfillPayload = {
        address,
        chainCursor,
        ...writePendingPayload(pending, processedIndex),
        pagesExhausted,
        newestTxid,
        newestBlockHeight,
        ...traceFieldsFromState(result.traceState),
      };
      await enqueueBackfillContinuation(store, pendingPayload, enqueueContinuation);
      return jobStatsFromTrace(
        {
          traceComplete: false,
          nextEdgeIndex: result.traceState.traceEdgeIndex ?? 0,
          edgesApplied: 0,
          traceEdgeTotal: result.traceState.traceEdgeTotal ?? 0,
        },
        true,
        result.cpuGuardTripped,
      );
    }
    processedIndex++;
    traceTxid = result.traceState.traceTxid;
    traceEdgeIndex = result.traceState.traceEdgeIndex;
    traceEdgesPending = result.traceState.traceEdgesPending;
    traceEdgeTotal = result.traceState.traceEdgeTotal;
    traceEdgesFlat = result.traceState.traceEdgesFlat;
    if ((limited && budget.exhausted()) || jobSubreq?.exhausted() || cpuGuard?.exceeded()) break;
  }

  const hasPending = processedIndex < pending.length;
  const needsMore = hasPending || !pagesExhausted || traceEdgesPending === true;

  const currentPayload: BackfillPayload = clearTraceFields({
    address,
    chainCursor,
    ...writePendingPayload(pending, processedIndex),
    pagesExhausted,
    newestTxid,
    newestBlockHeight,
    traceTxid,
    traceEdgeIndex,
    traceEdgesPending,
    traceEdgeTotal,
    traceEdgesFlat,
  });

  if (needsMore) {
    await enqueueBackfillContinuation(store, currentPayload, enqueueContinuation);
    return { continued: true };
  }

  if (newestTxid) {
    await store.upsertSyncState(address, {
      lastSeenTxid: newestTxid,
      lastBlockHeight: newestBlockHeight,
    });
  }
  await store.upsertBackfillState(address, null, true);
  await store.setExpandStatus(address, "expanded");
  return { continued: false };
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

interface PollPayload extends PendingPayloadFields {
  address: string;
  pollFetched?: boolean;
  newestTxid?: string;
  newestBlockHeight?: number | null;
}

function parsePollPayload(raw: Record<string, unknown>): PollPayload {
  const { pending, processedIndex } = readPendingRuntime(raw);
  return {
    address: raw.address as string,
    ...writePendingPayload(pending, processedIndex),
    pollFetched: raw.pollFetched as boolean | undefined,
    newestTxid: raw.newestTxid as string | undefined,
    newestBlockHeight: raw.newestBlockHeight as number | null | undefined,
  };
}

function toPollJobPayload(payload: PollPayload): Record<string, unknown> {
  return {
    address: payload.address,
    pendingTxs: payload.pendingTxs,
    pendingTxids: payload.pendingTxids,
    processedIndex: payload.processedIndex,
    pollFetched: payload.pollFetched,
    newestTxid: payload.newestTxid,
    newestBlockHeight: payload.newestBlockHeight,
  };
}

async function pollHacker(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  rawPayload: Record<string, unknown>,
  options?: { hackers?: Set<string>; cpuGuard?: CpuGuard },
): Promise<void> {
  const payload = parsePollPayload(rawPayload);
  const address = payload.address;
  let pending = readPendingRuntime(payload as unknown as Record<string, unknown>).pending;
  let processedIndex = payload.processedIndex ?? 0;
  let pollFetched = payload.pollFetched ?? false;
  let newestTxid = payload.newestTxid;
  let newestBlockHeight = payload.newestBlockHeight ?? null;

  const budget = createChainCallBudget(config.maxChainCallsPerJob);
  const limited = config.maxChainCallsPerJob > 0;
  const needsProcess = processedIndex < pending.length;

  if (!pollFetched && !needsProcess && budget.canCall()) {
    const sync = await store.getSyncState(address);
    const txs = await router.withProvider((p) => p.getAddressTxs(address, sync?.lastSeenTxid ?? undefined));
    budget.consume();
    if (txs.length === 0) {
      await store.touchSyncPoll(address);
      return;
    }
    newestTxid = txs[0]!.txid;
    newestBlockHeight = txs[0]!.status?.block_height ?? null;
    pending = pendingFromPageTxs([...txs].reverse(), address);
    processedIndex = 0;
    pollFetched = true;
    if (limited && budget.exhausted()) {
      await store.enqueueJob("poll_hacker_address", toPollJobPayload({
        address,
        ...writePendingPayload(pending, processedIndex),
        pollFetched,
        newestTxid,
        newestBlockHeight,
      }), JOB_PRIORITY.POLL_HACKER);
      return;
    }
  }

  const hackers = options?.hackers ?? (await getHackerAddressSet(store));
  const cpuGuard = options?.cpuGuard;
  const processLimit = limited
    ? budget.processBatchLimit(1)
    : pending.length - processedIndex;
  let processed = 0;
  while (
    processedIndex < pending.length &&
    processed < processLimit &&
    budget.canCall() &&
    !cpuGuard?.exceeded()
  ) {
    const entry = pending[processedIndex]!;
    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      0,
      entry,
      hackers,
      {},
      { skipIfIndexed: false, cpuGuard },
    );
    if (result.chainCallsUsed > 0) budget.consume();
    processedIndex++;
    processed++;
    if (limited && budget.exhausted()) break;
  }

  const hasPending = processedIndex < pending.length;
  if (hasPending) {
    await store.enqueueJob(
      "poll_hacker_address",
      toPollJobPayload({
        address,
        ...writePendingPayload(pending, processedIndex),
        pollFetched: true,
        newestTxid,
        newestBlockHeight,
      }),
      JOB_PRIORITY.POLL_HACKER,
    );
    return;
  }

  if (pollFetched && newestTxid) {
    await store.upsertSyncState(address, {
      lastSeenTxid: newestTxid,
      lastBlockHeight: newestBlockHeight,
    });
  } else if (!pollFetched) {
    await store.touchSyncPoll(address);
  }
}

async function pollDownstream(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  rawPayload: Record<string, unknown>,
  options?: { hackers?: Set<string>; cpuGuard?: CpuGuard },
): Promise<void> {
  const payload = parsePollPayload(rawPayload);
  const address = payload.address;
  let pending = readPendingRuntime(payload as unknown as Record<string, unknown>).pending;
  let processedIndex = payload.processedIndex ?? 0;
  let pollFetched = payload.pollFetched ?? false;
  let newestTxid = payload.newestTxid;
  let newestBlockHeight = payload.newestBlockHeight ?? null;

  const addr = await store.getAddress(address);
  const hop = addr?.hopFromHacker ?? 0;
  const expandProfile = addr?.expandProfile ?? null;
  const budget = createChainCallBudget(config.maxChainCallsPerJob);
  const limited = config.maxChainCallsPerJob > 0;
  const needsProcess = processedIndex < pending.length;

  if (!pollFetched && !needsProcess && budget.canCall()) {
    const sync = await store.getSyncState(address);
    const txs = await router.withProvider((p) => p.getAddressTxs(address, sync?.lastSeenTxid ?? undefined));
    budget.consume();
    if (txs.length === 0) {
      await store.touchSyncPoll(address);
      return;
    }
    newestTxid = txs[0]!.txid;
    newestBlockHeight = txs[0]!.status?.block_height ?? null;
    pending = pendingFromPageTxs(txs, address);
    processedIndex = 0;
    pollFetched = true;
    if (limited && budget.exhausted()) {
      await store.enqueueJob("poll_downstream_address", toPollJobPayload({
        address,
        ...writePendingPayload(pending, processedIndex),
        pollFetched,
        newestTxid,
        newestBlockHeight,
      }), JOB_PRIORITY.POLL_DOWNSTREAM);
      return;
    }
  }

  const hackers = options?.hackers ?? (await getHackerAddressSet(store));
  const cpuGuard = options?.cpuGuard;
  const processLimit = limited
    ? budget.processBatchLimit(1)
    : pending.length - processedIndex;
  let processed = 0;
  const batch: PendingTxRuntime[] = [];
  while (
    processedIndex < pending.length &&
    processed < processLimit &&
    budget.canCall() &&
    !cpuGuard?.exceeded()
  ) {
    batch.push(pending[processedIndex]!);
    processedIndex++;
    processed++;
  }
  if (batch.length > 0) {
    const maxCalls = limited ? 1 : undefined;
    await processAddressTxs(store, router, config, address, batch, hackers, hop, maxCalls, undefined, expandProfile);
    if (limited) budget.consume();
  }

  const hasPending = processedIndex < pending.length;
  if (hasPending) {
    await store.enqueueJob(
      "poll_downstream_address",
      toPollJobPayload({
        address,
        ...writePendingPayload(pending, processedIndex),
        pollFetched: true,
        newestTxid,
        newestBlockHeight,
      }),
      JOB_PRIORITY.POLL_DOWNSTREAM,
    );
    return;
  }

  if (pollFetched && newestTxid) {
    await store.upsertSyncState(address, {
      lastSeenTxid: newestTxid,
      lastBlockHeight: newestBlockHeight,
    });
  } else if (!pollFetched) {
    await store.touchSyncPoll(address);
  }
}

interface ExpandPayload extends PendingPayloadFields {
  address: string;
  chainCursor?: string;
  pagesExhausted?: boolean;
  newestTxid?: string;
  newestBlockHeight?: number | null;
  pagesFetched?: number;
  traceTxid?: string;
  traceEdgeIndex?: number;
  traceEdgesPending?: boolean;
  traceEdgeTotal?: number;
  traceEdgesFlat?: HackTraceEdgeDraft[];
}

/** Chunked expand: paginate address txs and process up to backfillTxsPerJob per job tick. */
async function expandDownstream(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  rawPayload: Record<string, unknown>,
  options?: { jobSubreq?: JobSubrequestBudget; hackers?: Set<string>; cpuGuard?: CpuGuard },
): Promise<JobRunStats | undefined> {
  const jobSubreq = options?.jobSubreq;
  const cpuGuard = options?.cpuGuard;
  const address = rawPayload.address as string;
  let pending = readPendingRuntime(rawPayload).pending;
  let processedIndex = (rawPayload.processedIndex as number | undefined) ?? 0;
  let chainCursor = rawPayload.chainCursor as string | undefined;
  let pagesExhausted = (rawPayload.pagesExhausted as boolean | undefined) ?? false;
  let newestTxid = rawPayload.newestTxid as string | undefined;
  let newestBlockHeight = (rawPayload.newestBlockHeight as number | null | undefined) ?? null;
  let pagesFetched = (rawPayload.pagesFetched as number | undefined) ?? 0;
  let traceTxid = rawPayload.traceTxid as string | undefined;
  let traceEdgeIndex = rawPayload.traceEdgeIndex as number | undefined;
  let traceEdgesPending = rawPayload.traceEdgesPending as boolean | undefined;
  let traceEdgeTotal = rawPayload.traceEdgeTotal as number | undefined;
  let traceEdgesFlat = rawPayload.traceEdgesFlat as HackTraceEdgeDraft[] | undefined;

  const addr = await store.getAddress(address);
  const hop = addr?.hopFromHacker ?? 0;
  const expandProfile = addr?.expandProfile ?? null;
  const hackers = options?.hackers ?? (await getHackerAddressSet(store));
  await store.setExpandStatus(address, "expanding");

  const budget = createChainCallBudget(config.maxChainCallsPerJob);
  const limited = config.maxChainCallsPerJob > 0;
  const maxPages = Math.max(1, Math.ceil(config.backfillMaxTxs / 25));
  const needsProcess = processedIndex < pending.length;
  const needsFetch =
    processedIndex >= pending.length && !pagesExhausted && pagesFetched < maxPages;

  if ((!limited || !needsProcess) && needsFetch && budget.canCall() && (!jobSubreq || jobSubreq.canUse())) {
    const { txs } = await router.fetchAddressTxPage(address, chainCursor);
    budget.consume();
    pagesFetched++;
    if (txs.length === 0) {
      pagesExhausted = true;
    } else {
      if (!newestTxid) {
        newestTxid = txs[0]!.txid;
        newestBlockHeight = txs[0]!.status?.block_height ?? null;
      }
      pending = pendingFromPageTxs(txs, address);
      processedIndex = 0;
      chainCursor = txs[txs.length - 1]!.txid;
      if (pagesFetched * 25 >= config.backfillMaxTxs) pagesExhausted = true;

      if (pagesFetched === 1) {
        const relay = detectSweepRelay(
          { entries: pending, spendTargets: collectSpendTargetsFromRuntime(pending) },
          config,
        );
        if (relay.matched && relay.meta) {
          await store.setExpandProfile(address, "sweep_relay", {
            relayMetaJson: JSON.stringify(relay.meta),
          });
        }
      }
    }
    if ((limited && budget.exhausted()) || jobSubreq?.exhausted()) {
      const hasPendingAfterFetch = processedIndex < pending.length;
      const needsMoreAfterFetch = hasPendingAfterFetch || !pagesExhausted;
      if (needsMoreAfterFetch) {
        const nextPayload: ExpandPayload = {
          address,
          chainCursor,
          ...writePendingPayload(pending, processedIndex),
          pagesExhausted,
          newestTxid,
          newestBlockHeight,
          pagesFetched,
        };
        await store.enqueueJob(
          "expand_downstream",
          nextPayload as unknown as Record<string, unknown>,
          JOB_PRIORITY.CRON_EXPAND,
        );
        return { continued: true };
      }
    }
  } else if (pagesFetched >= maxPages) {
    pagesExhausted = true;
  }

  const processLimit = limited
    ? budget.processBatchLimit(config.backfillTxsPerJob)
    : config.backfillTxsPerJob;
  let processed = 0;
  while (
    processedIndex < pending.length &&
    processed < processLimit &&
    budget.canCall() &&
    (!jobSubreq || jobSubreq.canUse()) &&
    !cpuGuard?.exceeded()
  ) {
    const entry = pending[processedIndex]!;
    const result = await processClassifiedPendingTx(
      store,
      router,
      config,
      address,
      hop,
      entry,
      hackers,
      { traceTxid, traceEdgeIndex, traceEdgesPending, traceEdgeTotal, traceEdgesFlat },
      { expandProfile, cpuGuard },
    );
    if (result.chainCallsUsed > 0) budget.consume();
    processed++;
    if (result.continued) {
      await store.enqueueJob(
        "expand_downstream",
        {
          address,
          chainCursor,
          ...writePendingPayload(pending, processedIndex),
          pagesExhausted,
          newestTxid,
          newestBlockHeight,
          pagesFetched,
          ...traceFieldsFromState(result.traceState),
        } as unknown as Record<string, unknown>,
        JOB_PRIORITY.CRON_EXPAND,
      );
      return jobStatsFromTrace(
        {
          traceComplete: false,
          nextEdgeIndex: result.traceState.traceEdgeIndex ?? 0,
          edgesApplied: 0,
          traceEdgeTotal: result.traceState.traceEdgeTotal ?? 0,
        },
        true,
        result.cpuGuardTripped,
      );
    }
    processedIndex++;
    traceTxid = result.traceState.traceTxid;
    traceEdgeIndex = result.traceState.traceEdgeIndex;
    traceEdgesPending = result.traceState.traceEdgesPending;
    traceEdgeTotal = result.traceState.traceEdgeTotal;
    traceEdgesFlat = result.traceState.traceEdgesFlat;
    if ((limited && budget.exhausted()) || jobSubreq?.exhausted() || cpuGuard?.exceeded()) break;
  }

  const hasPending = processedIndex < pending.length;
  const needsMore = hasPending || !pagesExhausted || traceEdgesPending === true;

  const nextPayload: ExpandPayload = {
    address,
    chainCursor,
    ...writePendingPayload(pending, processedIndex),
    pagesExhausted,
    newestTxid,
    newestBlockHeight,
    pagesFetched,
    traceTxid,
    traceEdgeIndex,
    traceEdgesPending,
    traceEdgeTotal,
    traceEdgesFlat,
  };

  if (needsMore) {
    await store.enqueueJob(
      "expand_downstream",
      nextPayload as unknown as Record<string, unknown>,
      JOB_PRIORITY.CRON_EXPAND,
    );
    return { continued: true };
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
  return { continued: false };
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

async function syncColdcardwatch(
  store: Store,
  config: AppConfig,
  payload: Record<string, unknown>,
  opts?: { jobSubreq?: JobSubrequestBudget },
): Promise<void> {
  if (payload.collectors != null || payload.victims != null || payload.downstream != null) {
    await applyColdcardWatchSyncBatch(
      store,
      payload as unknown as Parameters<typeof applyColdcardWatchSyncBatch>[1],
      { jobSubreq: opts?.jobSubreq },
    );
    return;
  }
  const data = await fetchColdcardWatch(config.coldcardwatchBase, store);
  const prev = await store.getSourceSync("coldcardwatch");
  if (prev?.lastContentHash === data.contentHash) return;
  await enqueueColdcardWatchBatchJobs(store, data, config.syncAddressesPerJob);
}

async function syncVercelTrackers(
  store: Store,
  config: AppConfig,
  payload: Record<string, unknown>,
  opts?: { jobSubreq?: JobSubrequestBudget },
): Promise<void> {
  if (payload.source === "coldcard_hack_tracker" && payload.addresses != null) {
    await applyColdcardHackTrackerSyncBatch(
      store,
      payload as unknown as Parameters<typeof applyColdcardHackTrackerSyncBatch>[1],
      { jobSubreq: opts?.jobSubreq },
    );
    return;
  }
  if (payload.source === "coldcard_sweep_watch" && (payload.collectors != null || payload.vaults != null)) {
    await applyColdcardSweepWatchSyncBatch(
      store,
      payload as unknown as Parameters<typeof applyColdcardSweepWatchSyncBatch>[1],
      { jobSubreq: opts?.jobSubreq },
    );
    return;
  }

  const [hackData, sweepData] = await Promise.all([
    fetchColdcardHackTracker(config.coldcardHackTrackerBase, store),
    fetchColdcardSweepWatch(config.coldcardSweepWatchBase, store),
  ]);

  const prevHack = await store.getSourceSync("coldcard_hack_tracker");
  const prevSweep = await store.getSourceSync("coldcard_sweep_watch");
  const hackUnchanged = prevHack?.lastContentHash === hackData.contentHash;
  const sweepUnchanged = prevSweep?.lastContentHash === sweepData.contentHash;
  if (hackUnchanged && sweepUnchanged) return;

  if (!hackUnchanged) await enqueueColdcardHackTrackerBatchJobs(store, hackData, config.syncAddressesPerJob);
  if (!sweepUnchanged) await enqueueColdcardSweepWatchBatchJobs(store, sweepData, config.syncAddressesPerJob);
}

export async function processJob(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  job: Job,
  opts?: { jobSubreq?: JobSubrequestBudget; hackers?: Set<string>; cpuGuard?: CpuGuard },
): Promise<JobRunStats | undefined> {
  const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
  const jobOpts = { jobSubreq: opts?.jobSubreq, hackers: opts?.hackers, cpuGuard: opts?.cpuGuard };
  switch (job.type) {
    case "backfill_hacker_address":
      return backfillHacker(store, router, config, payload, jobOpts);
    case "audit_hacker_backfill":
      await auditHackerBackfill(store, router, config, payload.address as string);
      break;
    case "poll_hacker_address":
      await pollHacker(store, router, config, payload, jobOpts);
      break;
    case "poll_downstream_address":
      await pollDownstream(store, router, config, payload, jobOpts);
      break;
    case "expand_downstream":
      return expandDownstream(store, router, config, payload, jobOpts);
    case "refresh_live_balance":
      await refreshBalance(store, router, payload.address as string);
      break;
    case "refresh_btc_usd_price": {
      const { usd, at } = await fetchMempoolBtcUsd(config.mempoolBase, store);
      await store.setBtcUsdPrice(usd, at);
      break;
    }
    case "sync_coldcardwatch":
      await syncColdcardwatch(store, config, payload);
      break;
    case "sync_vercel_trackers":
      await syncVercelTrackers(store, config, payload);
      break;
    case "process_tx": {
      const hackers = opts?.hackers ?? (await getHackerAddressSet(store));
      await processTxForHackTrace(store, router, payload.txid as string, hackers, {
        maxGraphEdgesPerTx: config.maxGraphEdgesPerTx > 0 ? config.maxGraphEdgesPerTx : undefined,
        maxEdgesPerJob: config.maxEdgesPerJob > 0 ? config.maxEdgesPerJob : undefined,
        cpuGuard: opts?.cpuGuard,
        deferGraphActivityBump: config.deferGraphActivityBump,
      });
      break;
    }
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
  opts?: {
    deadlineMs?: number;
    jobDetails?: boolean;
    logColor?: boolean;
    subrequestBudget?: SubrequestBudget;
  },
): Promise<ProcessJobsResult> {
  const jobDetails = opts?.jobDetails ?? false;
  const logColor = opts?.logColor ?? false;
  const budget = opts?.subrequestBudget;
  let processed = 0;
  let stopReason: TickStopReason = "jobs_cap";
  let cachedHackers: Set<string> | undefined;
  for (let i = 0; i < config.jobsPerTick; i++) {
    if (opts?.deadlineMs != null && Date.now() >= opts.deadlineMs) {
      stopReason = "deadline";
      break;
    }
    if (budget && budget.limit() > 0) {
      const reserve = config.scheduleSubrequestReserve;
      if (budget.remaining() <= reserve + 2) {
        stopReason = "subreq";
        break;
      }
    }
    if (!store.canUseSubrequests(1)) {
      stopReason = "subreq";
      break;
    }
    const job =
      (await store.claimNextIngestJob({ preferContinuation: true })) ?? (await store.claimNextJob());
    if (!job) {
      stopReason = "idle";
      break;
    }
    if (jobDetails) {
      logJobStart(job, { color: logColor });
    }
    if (isIngestJobType(job.type) && !cachedHackers) {
      cachedHackers = await getHackerAddressSet(store);
    }
    const subreqBefore = budget?.used() ?? 0;
    const jobSubreq = createJobSubrequestBudget(config.maxSubrequestsPerJob, budget, subreqBefore);
    const cpuGuard = createCpuGuardFromConfig(config.jobCpuGuardMs);
    const hackers = isIngestJobType(job.type) ? cachedHackers : undefined;
    try {
      let runStats: JobRunStats | undefined;
      if (job.type === "sync_coldcardwatch") {
        await syncColdcardwatch(
          store,
          config,
          JSON.parse(job.payloadJson) as Record<string, unknown>,
          { jobSubreq },
        );
      } else if (job.type === "sync_vercel_trackers") {
        await syncVercelTrackers(
          store,
          config,
          JSON.parse(job.payloadJson) as Record<string, unknown>,
          { jobSubreq },
        );
      } else {
        runStats = await processJob(store, router, config, job, { jobSubreq, hackers, cpuGuard });
      }
      await store.completeJob(job.id);
      await store.maybeClearQueueSchedulingPause();
      processed++;
      const workSubreq = (budget?.used() ?? 0) - subreqBefore;
      const queueDepth = await store.getQueueDepth();
      logJobDone(job, formatJobDurationMs(jobDurationMs(job)), queueDepth, {
        color: logColor,
        runStats,
        workSubreq: budget && budget.limit() > 0 ? workSubreq : undefined,
      });
      if (budget && budget.limit() > 0 && budget.remaining() <= config.scheduleSubrequestReserve + 2) {
        stopReason = "subreq";
        break;
      }
    } catch (err) {
      if (await handleJobFailure(store, config, job, err, logColor)) {
        stopReason = "subreq";
        break;
      }
    }
  }
  return { processed, stopReason };
}
