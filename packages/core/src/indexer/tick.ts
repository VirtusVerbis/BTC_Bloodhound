import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { scheduleBtcUsdPriceRefresh, scheduleDownstreamCrawl } from "./crawl.js";
import { logCronDetail } from "./jobLog.js";
import { processJobs } from "./processor.js";

export interface IndexerTickResult {
  scheduled: boolean;
  jobsProcessed: number;
}

export interface IndexerTickOptions {
  schedule?: boolean;
  jobDetails?: boolean;
}

/** Extra lease time beyond tickBudgetMs so clearTickLease can run after the budget. */
export const TICK_LEASE_SKEW_MS = 10_000;

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
  const startedAt = Date.now();
  let jobsProcessed = 0;

  logCronDetail(jobDetails, "[cron] tick start");
  try {
    if (schedule) {
      await scheduleBtcUsdPriceRefresh(store, config);
      await scheduleDownstreamCrawl(store, config);
      logCronDetail(jobDetails, "[cron] schedule done");
    }
    const deadlineMs = Date.now() + config.tickBudgetMs;
    jobsProcessed = await processJobs(store, router, config, { deadlineMs, jobDetails });
    return { scheduled: schedule, jobsProcessed };
  } finally {
    const elapsed = Date.now() - startedAt;
    logCronDetail(jobDetails, `[cron] tick done processed=${jobsProcessed} ms=${elapsed}`);
  }
}
