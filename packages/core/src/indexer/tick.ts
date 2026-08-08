import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import type { ChainRouter } from "../chain/router.js";
import { scheduleBtcUsdPriceRefresh, scheduleDownstreamCrawl } from "./crawl.js";
import { processJobs } from "./processor.js";

export interface IndexerTickResult {
  scheduled: boolean;
  jobsProcessed: number;
}

/**
 * One indexer cron tick: optional schedule enqueue + process up to jobsPerTick jobs.
 * Used by the local infinite loop and the Cloudflare Cron Worker.
 */
export async function runIndexerTick(
  store: Store,
  router: ChainRouter,
  config: AppConfig,
  opts?: { schedule?: boolean },
): Promise<IndexerTickResult> {
  const schedule = opts?.schedule ?? true;
  if (schedule) {
    await scheduleBtcUsdPriceRefresh(store, config);
    await scheduleDownstreamCrawl(store, config);
  }
  const jobsProcessed = await processJobs(store, router, config);
  return { scheduled: schedule, jobsProcessed };
}
