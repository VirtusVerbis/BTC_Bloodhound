import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { fetchMempoolBtcUsd } from "../price/mempoolPrices.js";
import { buildBackfillJobPayload } from "./processor.js";
import { isRebuildActive } from "./rebuildMode.js";
import type { SubrequestBudget } from "./subrequestBudget.js";
import type { BtcScheduleMode, ScheduleTickStats } from "./tickStats.js";

const BACKFILL_DEDUPE_TYPES = ["backfill_hacker_address", "audit_hacker_backfill"] as const;

export interface ScheduleEnqueueCache {
  queueSchedulingPaused: boolean;
  queueDepth: number;
}

async function loadScheduleEnqueueCache(store: Store): Promise<ScheduleEnqueueCache> {
  const state = await store.getSchedulerState();
  return {
    queueSchedulingPaused: (state?.queueSchedulingPaused ?? 0) !== 0,
    queueDepth: await store.getQueueDepth(),
  };
}

function scheduleBudgetLow(budget: SubrequestBudget, reserve: number, minJobBudget = 5): boolean {
  if (budget.limit() <= 0) return false;
  return budget.remaining() <= reserve + minJobBudget;
}

async function enqueueBackfillResume(store: Store, address: string): Promise<void> {
  await store.enqueueJobIfAbsent(
    "backfill_hacker_address",
    await buildBackfillJobPayload(store, address),
    JOB_PRIORITY.BACKFILL_HACKER,
    undefined,
    { dedupeTypes: [...BACKFILL_DEDUPE_TYPES], address },
  );
}

export async function maintainOneHacker(
  store: Store,
  config: AppConfig,
  h: { address: string; liveBalanceAt?: string | null },
  ts: number,
): Promise<void> {
  const address = h.address;

  const addr = await store.getAddress(address);
  const status = addr?.expandStatus ?? "pending";
  const backfill = await store.getBackfillState(address);

  if (status === "pending" || status === "backfilling") {
    await enqueueBackfillResume(store, address);
  } else if (status === "expanded" && !backfill?.backfillComplete) {
    await enqueueBackfillResume(store, address);
  } else if (status === "expanded" && backfill?.backfillComplete) {
    const lastAudit = backfill.lastBackfillAuditAt
      ? new Date(backfill.lastBackfillAuditAt).getTime()
      : 0;
    if (ts - lastAudit >= config.backfillHealAuditIntervalSec * 1000) {
      await store.enqueueJobIfAbsent(
        "audit_hacker_backfill",
        { address },
        JOB_PRIORITY.BACKFILL_HACKER,
        undefined,
        { dedupeTypes: [...BACKFILL_DEDUPE_TYPES], address },
      );
    }
  }

  const balanceAt = h.liveBalanceAt ? new Date(h.liveBalanceAt).getTime() : 0;
  if (ts - balanceAt >= config.balanceRefreshIntervalSec * 1000) {
    await store.enqueueJobIfAbsent(
      "refresh_live_balance",
      { address },
      JOB_PRIORITY.REFRESH_BALANCE,
      undefined,
      { address },
    );
  }

  const backfillState = await store.getBackfillState(address);
  if (backfillState?.backfillComplete) {
    const sync = await store.getSyncState(address);
    const lastPoll = sync?.lastPolledAt ? new Date(sync.lastPolledAt).getTime() : 0;
    if (ts - lastPoll >= config.cronIntervalSec * 1000) {
      await store.enqueueJobIfAbsent(
        "poll_hacker_address",
        { address },
        JOB_PRIORITY.POLL_HACKER,
        undefined,
        { address },
      );
    }
  }
}

export async function scheduleBtcUsdPriceRefresh(
  store: Store,
  _router: ChainRouter,
  config: AppConfig,
  budget: SubrequestBudget,
  reserve: number,
): Promise<BtcScheduleMode> {
  if (await store.isD1QuotaBlocked("write")) return "skip";

  const ts = Date.now();
  const intervalMs = config.btcUsdPriceRefreshIntervalSec * 1000;
  const price = await store.getBtcUsdPrice();
  const lastSuccessAt = price?.at ? new Date(price.at).getTime() : 0;
  if (price && ts - lastSuccessAt < intervalMs) return "fresh";

  const scheduler = await store.getSchedulerState();
  const lastAttemptAt = scheduler?.btcUsdRefreshAttemptAt
    ? new Date(scheduler.btcUsdRefreshAttemptAt).getTime()
    : 0;
  if (lastAttemptAt > 0 && ts - lastAttemptAt < intervalMs) return "skip";

  if (scheduleBudgetLow(budget, reserve)) {
    await store.enqueueJobIfAbsent("refresh_btc_usd_price", {}, JOB_PRIORITY.REFRESH_BTC_USD);
    return "queued";
  }

  await store.setBtcUsdRefreshAttemptAt(new Date(ts).toISOString());

  try {
    const { usd, at } = await fetchMempoolBtcUsd(config.mempoolBase, store);
    await store.setBtcUsdPrice(usd, at);
    return "inline";
  } catch (err) {
    console.warn(
      "BTC/USD inline refresh failed:",
      err instanceof Error ? err.message : err,
    );
    return "skip";
  }
}

export async function scheduleDownstreamCrawl(
  store: Store,
  config: AppConfig,
  budget: SubrequestBudget,
  reserve: number,
): Promise<Omit<ScheduleTickStats, "btc">> {
  const emptyStats = {
    skipNonCritical: false,
    crawlEnqueued: 0,
    pollEnqueued: 0,
    maintTick: false,
  };

  if (await isRebuildActive(store, config)) return emptyStats;

  if (await store.isD1QuotaBlocked("write")) {
    return { ...emptyStats, skipNonCritical: true };
  }

  const ts = Date.now();
  const enqueueCache = await loadScheduleEnqueueCache(store);
  const throttled = enqueueCache.queueDepth >= config.queueSoftThrottleDepth;
  const skipNonCritical = scheduleBudgetLow(budget, reserve);
  let crawlEnqueued = 0;
  let pollEnqueued = 0;

  const cwSync = await store.getSourceSync("coldcardwatch");
  const cwLast = cwSync?.lastSyncAt ? new Date(cwSync.lastSyncAt).getTime() : 0;
  if (!skipNonCritical && ts - cwLast >= config.coldcardwatchSyncIntervalSec * 1000) {
    if (!enqueueCache.queueSchedulingPaused && enqueueCache.queueDepth < config.maxQueueDepth) {
      await store.enqueueJobIfAbsent("sync_coldcardwatch", {}, JOB_PRIORITY.SYNC_COLDCARDWATCH);
    }
  }

  const htSync = await store.getSourceSync("coldcard_hack_tracker");
  const swSync = await store.getSourceSync("coldcard_sweep_watch");
  const htLast = htSync?.lastSyncAt ? new Date(htSync.lastSyncAt).getTime() : 0;
  const swLast = swSync?.lastSyncAt ? new Date(swSync.lastSyncAt).getTime() : 0;
  const vtLast = Math.max(htLast, swLast);
  if (!skipNonCritical && ts - vtLast >= config.vercelTrackersSyncIntervalSec * 1000) {
    if (!enqueueCache.queueSchedulingPaused && enqueueCache.queueDepth < config.maxQueueDepth) {
      await store.enqueueJobIfAbsent("sync_vercel_trackers", {}, JOB_PRIORITY.SYNC_VERCEL_TRACKERS);
    }
  }

  const tick = await store.incrementMaintenanceCronCounter();
  const isMaintTick =
    config.hackerMaintenanceEveryNCrons > 0 &&
    tick % config.hackerMaintenanceEveryNCrons === 0;
  const isOpReturnMaintTick =
    config.opReturnBackfillEveryNCrons > 0 &&
    tick % config.opReturnBackfillEveryNCrons === 0;
  if (isMaintTick && !scheduleBudgetLow(budget, reserve, 8)) {
    const hackers = await store.listHackers();
    if (hackers.length > 0) {
      const idx = await store.claimNextHackerPollIndex(hackers.length);
      await maintainOneHacker(store, config, hackers[idx]!, ts);
    }
  }

  if (skipNonCritical) {
    return { ...emptyStats, skipNonCritical, maintTick: isMaintTick, throttled };
  }

  if (throttled) {
    return { ...emptyStats, skipNonCritical: false, maintTick: isMaintTick, throttled };
  }

  if (
    isOpReturnMaintTick &&
    !skipNonCritical &&
    !enqueueCache.queueSchedulingPaused &&
    enqueueCache.queueDepth < config.maxQueueDepth &&
    !scheduleBudgetLow(budget, reserve)
  ) {
    const missingOpReturn = await store.countTransactionsMissingOpReturn();
    if (missingOpReturn > 0) {
      await store.enqueueJobIfAbsent(
        "backfill_op_return",
        {},
        JOB_PRIORITY.REFRESH_BALANCE,
        undefined,
        { dedupeTypes: ["backfill_op_return"] },
      );
    }
  }

  const hackers = await store.listHackers();
  if (hackers.length > 0) {
    const idx = await store.claimNextHackerPollIndex(hackers.length);
    const frontier = await store.getCrawlEnqueueCandidates(
      hackers[idx]!.address,
      config.crawlEnqueuePerCron,
      config.maxCrawlDepth,
    );
    for (const row of frontier) {
      const jobId = await store.enqueueJobIfAbsent(
        "expand_downstream",
        { address: row.address, cron: true },
        JOB_PRIORITY.CRON_EXPAND,
        undefined,
        { address: row.address },
      );
      if (jobId != null) {
        crawlEnqueued++;
        await store.setExpandStatus(row.address, "queued");
      }
    }
  }

  const pollCandidates = await store.listDownstreamForPoll(
    config.downstreamPollEnqueuePerCron,
    config.maxCrawlDepth,
    config.downstreamPollIntervalSec,
  );
  for (const row of pollCandidates) {
    const jobId = await store.enqueueJobIfAbsent(
      "poll_downstream_address",
      { address: row.address },
      JOB_PRIORITY.POLL_DOWNSTREAM,
      undefined,
      { address: row.address },
    );
    if (jobId != null) pollEnqueued++;
  }

  return {
    skipNonCritical,
    crawlEnqueued,
    pollEnqueued,
    maintTick: isMaintTick,
    throttled: false,
  };
}
