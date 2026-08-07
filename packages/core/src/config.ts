export const JOB_PRIORITY = {
  POLL_HACKER: 10,
  SYNC_COLDCARDWATCH: 9,
  SYNC_VERCEL_TRACKERS: 9,
  REFRESH_BALANCE: 8,
  POLL_DOWNSTREAM: 7,
  USER_EXPAND: 6,
  PROCESS_TX: 4,
  BACKFILL_HACKER: 2,
  CRON_EXPAND: 1,
} as const;

export type JobType =
  | "seed_public_hackers"
  | "backfill_hacker_address"
  | "process_tx"
  | "poll_hacker_address"
  | "poll_downstream_address"
  | "expand_downstream"
  | "refresh_live_balance"
  | "sync_coldcardwatch"
  | "sync_vercel_trackers";

export interface AppConfig {
  databaseUrl: string;
  esploraBase: string;
  mempoolBase: string;
  rateLimitMs: number;
  jobsPerTick: number;
  cronIntervalSec: number;
  crawlEnqueuePerCron: number;
  downstreamPollIntervalSec: number;
  downstreamPollEnqueuePerCron: number;
  maxCrawlDepth: number;
  maxGraphDepth: number;
  maxGraphOutputs: number;
  minEdgeSats: number;
  balanceRefreshIntervalSec: number;
  coldcardwatchSyncIntervalSec: number;
  coldcardwatchBase: string;
  vercelTrackersSyncIntervalSec: number;
  coldcardSweepWatchBase: string;
  coldcardHackTrackerBase: string;
  monitoringStaleSec: number;
  adminToken: string;
  seedFilePath: string;
  localWatchlistPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? "file:./data/cointrace.db",
    esploraBase: (env.ESPLORA_BASE ?? "https://blockstream.info/api").replace(/\/$/, ""),
    mempoolBase: (env.MEMPOOL_BASE ?? "https://mempool.space/api").replace(/\/$/, ""),
    rateLimitMs: Number(env.RATE_LIMIT_MS ?? 3000),
    jobsPerTick: Number(env.JOBS_PER_TICK ?? 1),
    cronIntervalSec: Number(env.CRON_INTERVAL_SEC ?? 60),
    crawlEnqueuePerCron: Number(env.CRAWL_ENQUEUE_PER_CRON ?? 5),
    downstreamPollIntervalSec: Number(env.DOWNSTREAM_POLL_INTERVAL_SEC ?? 600),
    downstreamPollEnqueuePerCron: Number(env.DOWNSTREAM_POLL_ENQUEUE_PER_CRON ?? 10),
    maxCrawlDepth: Number(env.MAX_CRAWL_DEPTH ?? 5),
    maxGraphDepth: Number(env.MAX_GRAPH_DEPTH ?? 2),
    maxGraphOutputs: Number(env.MAX_GRAPH_OUTPUTS ?? 20),
    minEdgeSats: Number(env.MIN_EDGE_SATS ?? 1000),
    balanceRefreshIntervalSec: Number(env.BALANCE_REFRESH_INTERVAL_SEC ?? 300),
    coldcardwatchSyncIntervalSec: Number(env.COLDCARDWATCH_SYNC_INTERVAL_SEC ?? 3600),
    coldcardwatchBase: (env.COLDCARDWATCH_BASE ?? "https://coldcardwatch.com").replace(/\/$/, ""),
    vercelTrackersSyncIntervalSec: Number(env.VERCEL_TRACKERS_SYNC_INTERVAL_SEC ?? 3600),
    coldcardSweepWatchBase: (env.COLDCARD_SWEEP_WATCH_BASE ?? "https://coldcard-watch.vercel.app").replace(
      /\/$/,
      "",
    ),
    coldcardHackTrackerBase: (
      env.COLDCARD_HACK_TRACKER_BASE ?? "https://coldcard-hack-tracker.vercel.app"
    ).replace(/\/$/, ""),
    monitoringStaleSec: Number(env.MONITORING_STALE_SEC ?? 600),
    adminToken: env.ADMIN_TOKEN ?? "change-me",
    seedFilePath: env.SEED_FILE ?? "./config/watchlist.seed.json",
    localWatchlistPath: env.LOCAL_WATCHLIST ?? "./config/watchlist.local.json",
  };
}
