export const JOB_PRIORITY = {
  POLL_HACKER: 10,
  SYNC_COLDCARDWATCH: 9,
  REFRESH_BALANCE: 8,
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
  | "expand_downstream"
  | "refresh_live_balance"
  | "sync_coldcardwatch";

export interface AppConfig {
  databaseUrl: string;
  esploraBase: string;
  mempoolBase: string;
  rateLimitMs: number;
  jobsPerTick: number;
  cronIntervalSec: number;
  crawlEnqueuePerCron: number;
  maxCrawlDepth: number;
  maxGraphDepth: number;
  maxGraphOutputs: number;
  minEdgeSats: number;
  balanceRefreshIntervalSec: number;
  coldcardwatchSyncIntervalSec: number;
  coldcardwatchBase: string;
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
    crawlEnqueuePerCron: Number(env.CRAWL_ENQUEUE_PER_CRON ?? 1),
    maxCrawlDepth: Number(env.MAX_CRAWL_DEPTH ?? 5),
    maxGraphDepth: Number(env.MAX_GRAPH_DEPTH ?? 2),
    maxGraphOutputs: Number(env.MAX_GRAPH_OUTPUTS ?? 20),
    minEdgeSats: Number(env.MIN_EDGE_SATS ?? 1000),
    balanceRefreshIntervalSec: Number(env.BALANCE_REFRESH_INTERVAL_SEC ?? 300),
    coldcardwatchSyncIntervalSec: Number(env.COLDCARDWATCH_SYNC_INTERVAL_SEC ?? 3600),
    coldcardwatchBase: (env.COLDCARDWATCH_BASE ?? "https://coldcardwatch.com").replace(/\/$/, ""),
    adminToken: env.ADMIN_TOKEN ?? "change-me",
    seedFilePath: env.SEED_FILE ?? "./config/watchlist.seed.json",
    localWatchlistPath: env.LOCAL_WATCHLIST ?? "./config/watchlist.local.json",
  };
}
