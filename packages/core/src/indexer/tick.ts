import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { scheduleBtcUsdPriceRefresh, scheduleDownstreamCrawl } from "./crawl.js";
import { logCronDetail } from "./jobLog.js";
import { processJobs } from "./processor.js";
import {
  createSubrequestBudget,
  createUnlimitedSubrequestBudget,
  scheduleSubrequestReserve,
  type SubrequestBudget,
} from "./subrequestBudget.js";
import { formatCronScheduleDoneLine, formatCronTickDoneLine, formatTickPlanLine, type TickStopReason } from "./tickStats.js";
import { planTickJobs, shouldDrainBeforeSchedule } from "./tickPolicy.js";

export interface IndexerTickResult {
  scheduled: boolean;
  jobsProcessed: number;
}

export interface IndexerTickOptions {
  schedule?: boolean;
  jobDetails?: boolean;
  logColor?: boolean;
}

/** Extra lease time beyond tickBudgetMs so clearTickLease can run after the budget. */
export const TICK_LEASE_SKEW_MS = 10_000;

function attachSubrequestBudget(store: Store, config: AppConfig): SubrequestBudget {
  const budget =
    config.subrequestLimitPerInvocation > 0
      ? createSubrequestBudget(config.subrequestLimitPerInvocation)
      : createUnlimitedSubrequestBudget();
  store.setSubrequestBudget(budget);
  return budget;
}

async function runSchedulePhase(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  budget: SubrequestBudget,
  jobDetails: boolean,
  logColor: boolean,
): Promise<number> {
  const maintCounter = (await store.getSchedulerState())?.maintenanceCronCounter ?? 0;
  const reserve = scheduleSubrequestReserve({
    scheduleSubrequestReserve: config.scheduleSubrequestReserve,
    scheduleReserveMaintExtra: config.scheduleReserveMaintExtra,
    hackerMaintenanceEveryNCrons: config.hackerMaintenanceEveryNCrons,
    maintenanceCronCounter: maintCounter + 1,
  });
  const schedBefore = budget.used();
  const btc = await scheduleBtcUsdPriceRefresh(store, router, config, budget, reserve);
  const crawlStats = await scheduleDownstreamCrawl(store, config, budget, reserve);
  const schedSubreq = budget.used() - schedBefore;
  logCronDetail(
    jobDetails,
    formatCronScheduleDoneLine({ ...crawlStats, btc }, budget, schedSubreq),
    logColor,
  );
  return schedSubreq;
}

/**
 * One indexer cron tick: optional schedule enqueue + process up to jobsPerTick jobs
 * (or until tickBudgetMs wall deadline).
 * Used by the local infinite loop and the Cloudflare Cron Worker.
 */
export async function runIndexerTick(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  opts?: IndexerTickOptions,
): Promise<IndexerTickResult> {
  const schedule = opts?.schedule ?? true;
  const jobDetails = opts?.jobDetails ?? false;
  const logColor = opts?.logColor ?? config.indexerLogColor;
  const startedAt = Date.now();
  let jobsProcessed = 0;
  let tickStop: TickStopReason = "idle";
  let schedSubreq = 0;
  let drainFirst = false;
  let jobsCap = config.jobsPerTick;
  let jobsCapReason = "no_pair";
  const budget = attachSubrequestBudget(store, config);

  logCronDetail(jobDetails, "[cron] tick start", logColor);
  try {
    const queueDepth = await store.getQueueDepth();
    const continuationPending = schedule ? await store.hasPendingIngestContinuation() : false;
    drainFirst = shouldDrainBeforeSchedule({
      continuationPending,
      queueDepth,
      queueDrainFirstDepth: config.queueDrainFirstDepth,
    });
    const ingestCandidates = await store.listPendingIngestCandidates(32);
    const tickPlan = planTickJobs(config, queueDepth, ingestCandidates, budget);
    jobsCap = tickPlan.jobsCap;
    jobsCapReason = tickPlan.reason;
    logCronDetail(
      jobDetails,
      formatTickPlanLine({
        jobsCap: tickPlan.jobsCap,
        jobsCapReason: tickPlan.reason,
        headWeight: tickPlan.headWeight,
        pairable: tickPlan.pairableCount,
        queue: queueDepth,
      }),
      logColor,
    );
    const deadlineMs = Date.now() + config.tickBudgetMs;
    const jobOpts = {
      deadlineMs,
      jobDetails,
      logColor,
      subrequestBudget: budget,
      jobsPerTick: jobsCap,
    };

    if (drainFirst) {
      const jobResult = await processJobs(store, router, config, jobOpts);
      jobsProcessed = jobResult.processed;
      tickStop = jobResult.stopReason;

      if (schedule && budget.remaining() > config.scheduleSubrequestReserve) {
        schedSubreq = await runSchedulePhase(store, router, config, budget, jobDetails, logColor);
      } else if (schedule) {
        logCronDetail(
          jobDetails,
          `[cron] schedule skipped drainFirst=true budget=low`,
          logColor,
        );
      }
    } else {
      if (schedule) {
        schedSubreq = await runSchedulePhase(store, router, config, budget, jobDetails, logColor);
      }
      const jobResult = await processJobs(store, router, config, jobOpts);
      jobsProcessed = jobResult.processed;
      tickStop = jobResult.stopReason;
    }
    return { scheduled: schedule, jobsProcessed };
  } finally {
    store.setSubrequestBudget(undefined);
    const elapsed = Date.now() - startedAt;
    const queue = await store.getQueueDepth();
    const subreqLimit = budget.limit();
    const subreqUsed = budget.used();
    logCronDetail(
      jobDetails,
      formatCronTickDoneLine({
        processed: jobsProcessed,
        elapsedMs: elapsed,
        subreqUsed,
        subreqLimit,
        schedSubreq,
        workSubreq: subreqUsed - schedSubreq,
        subreqRem: subreqLimit > 0 ? budget.remaining() : 0,
        queue,
        stop: tickStop,
        order: drainFirst ? "drain" : "schedule-first",
        jobsCap,
        jobsCapReason,
      }),
      logColor,
    );
  }
}
