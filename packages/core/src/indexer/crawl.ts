import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { fetchMempoolBtcUsd } from "../price/mempoolPrices.js";
import { buildBackfillJobPayload } from "./processor.js";
import { BACKFILL_DEDUPE_TYPES } from "./jobClass.js";
import { isRebuildActive } from "./rebuildMode.js";
import { logCronDetail } from "./jobLog.js";
import type { IndexerLogColorMode } from "./logColor.js";
import { formatMaintenanceLogLine, runScheduledMaintenance } from "./maintenance.js";
import { shouldEnqueueRefreshLiveBalance } from "./addressStats.js";
import type { SubrequestBudget } from "./subrequestBudget.js";
import type { BtcScheduleMode, ScheduleTickStats } from "./tickStats.js";

export interface ScheduleDownstreamOpts {
  deadlineMs?: number;
  jobDetails?: boolean;
  logColor?: boolean;
  logColorMode?: IndexerLogColorMode;
}

export interface ScheduleEnqueueCache {
  queueSchedulingPaused: boolean;
  queueDepth: number;
}

async function loadScheduleEnqueueCache(store: Store): Promise<ScheduleEnqueueCache> {
  const state = await store.getSchedulerState();
  return {
    queueSchedulingPaused: (state?.queueSchedulingPaused ?? 0) !== 0,
    queueDepth: state?.pendingJobCount ?? 0,
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

export interface MaintainOneHackerOpts {
  throttled?: boolean;
}

export async function maintainOneHacker(
  store: Store,
  config: AppConfig,
  h: { address: string; liveBalanceAt?: string | null },
  ts: number,
  opts?: MaintainOneHackerOpts,
): Promise<void> {
  const address = h.address;
  const skipPollAndCosmetic = opts?.throttled === true;

  const addr = await store.getAddress(address);
  const status = addr?.expandStatus ?? "pending";
  const backfill = await store.getBackfillState(address);

  const auditDue =
    status === "expanded" &&
    (backfill?.backfillComplete ?? false) &&
    ts -
      (backfill?.lastBackfillAuditAt ? new Date(backfill.lastBackfillAuditAt).getTime() : 0) >=
      config.backfillHealAuditIntervalSec * 1000;

  if (status === "pending" || status === "backfilling") {
    await enqueueBackfillResume(store, address);
  } else if (status === "expanded" && !backfill?.backfillComplete) {
    await enqueueBackfillResume(store, address);
  } else if (auditDue && !skipPollAndCosmetic) {
    await store.enqueueJobIfAbsent(
      "audit_hacker_backfill",
      { address },
      JOB_PRIORITY.AUDIT_HACKER_BACKFILL,
      undefined,
      { dedupeTypes: [...BACKFILL_DEDUPE_TYPES], address },
    );
  }

  if (skipPollAndCosmetic) return;

  const backfillState = await store.getBackfillState(address);
  const sync = backfillState?.backfillComplete ? await store.getSyncState(address) : null;
  const lastPoll = sync?.lastPolledAt ? new Date(sync.lastPolledAt).getTime() : 0;
  const pollDue =
    (backfillState?.backfillComplete ?? false) &&
    ts - lastPoll >= config.cronIntervalSec * 1000;

  const balanceAt = h.liveBalanceAt ? new Date(h.liveBalanceAt).getTime() : 0;
  const balanceStale = ts - balanceAt >= config.balanceRefreshIntervalSec * 1000;
  if (
    shouldEnqueueRefreshLiveBalance({
      balanceStale,
      pollDue,
      auditDue,
    })
  ) {
    await store.enqueueJobIfAbsent(
      "refresh_live_balance",
      { address },
      JOB_PRIORITY.REFRESH_BALANCE,
      undefined,
      { address },
    );
  }

  if (pollDue) {
    await store.enqueueJobIfAbsent(
      "poll_hacker_address",
      { address },
      JOB_PRIORITY.POLL_HACKER,
      undefined,
      { address },
    );
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
  scheduleOpts?: ScheduleDownstreamOpts,
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

  const hackers = await store.listHackersCached();

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
    if (hackers.length > 0) {
      const idx = await store.claimNextHackerPollIndex(hackers.length);
      await maintainOneHacker(store, config, hackers[idx]!, ts, { throttled });
    }
  }

  try {
    if (!skipNonCritical && !throttled) {
      if (
        isOpReturnMaintTick &&
        !enqueueCache.queueSchedulingPaused &&
        enqueueCache.queueDepth < config.maxQueueDepth &&
        !scheduleBudgetLow(budget, reserve)
      ) {
        const missingOpReturn = await store.hasTransactionsMissingOpReturn();
        if (missingOpReturn) {
          await store.enqueueJobIfAbsent(
            "backfill_op_return",
            {},
            JOB_PRIORITY.REFRESH_BALANCE,
            undefined,
            { dedupeTypes: ["backfill_op_return"] },
          );
        }
      }

      const hackersForCrawl = hackers;
      if (hackersForCrawl.length > 0) {
        const idx = await store.claimNextHackerPollIndex(hackersForCrawl.length);
        const picked = hackersForCrawl[idx]!;
        if (!enqueueCache.queueSchedulingPaused) {
          const activeBackfills = await store.countActiveJobs("backfill_hacker_address");
          if (activeBackfills < config.maxPendingBackfillGlobal) {
            const addr = await store.getAddress(picked.address);
            const status = addr?.expandStatus;
            if (status === "pending" || status === "backfilling") {
              await enqueueBackfillResume(store, picked.address);
            }
          }
        }
        const frontier = await store.getCrawlEnqueueCandidates(
          picked.address,
          config.crawlEnqueuePerCron,
          config.maxCrawlDepth,
          config.minExpandSats,
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
        config.minExpandSats,
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
    }

    const maintenance = await runScheduledMaintenance(store, config, budget, tick, {
      deadlineMs: scheduleOpts?.deadlineMs,
      skipNonCritical,
    });
    if (scheduleOpts?.jobDetails) {
      logCronDetail(
        true,
        formatMaintenanceLogLine(maintenance),
        scheduleOpts.logColor ?? false,
        scheduleOpts.logColorMode,
      );
    }

    return {
      skipNonCritical,
      crawlEnqueued,
      pollEnqueued,
      maintTick: isMaintTick,
      throttled,
    };
  } finally {
    await store.ensureDownstreamTreeDepth(config.maxCrawlDepth).catch((err: unknown) => {
      console.error("ensureDownstreamTreeDepth failed", err);
    });
    await store
      .ensurePollDueCacheParams(
        config.maxCrawlDepth,
        config.downstreamPollIntervalSec,
        config.minExpandSats,
      )
      .catch((err: unknown) => {
        console.error("ensurePollDueCacheParams failed", err);
      });
    await store
      .maybeRefreshSyncSnapshot({
        maxCrawlDepth: config.maxCrawlDepth,
        downstreamPollIntervalSec: config.downstreamPollIntervalSec,
        minExpandSats: config.minExpandSats,
      })
      .catch((err: unknown) => {
        console.error("refreshSyncSnapshot failed", err);
      });
  }
}
