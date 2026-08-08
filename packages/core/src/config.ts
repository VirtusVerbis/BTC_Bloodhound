export const JOB_PRIORITY = {
  PROCESS_TX_REBUILD: 11,
  POLL_HACKER: 10,
  SYNC_COLDCARDWATCH: 9,
  SYNC_VERCEL_TRACKERS: 9,
  REFRESH_BALANCE: 8,
  REFRESH_BTC_USD: 8,
  POLL_DOWNSTREAM: 7,
  USER_EXPAND: 6,
  PROCESS_TX: 4,
  BACKFILL_HACKER: 2,
  CRON_EXPAND: 1,
} as const;

export type JobType =
  | "seed_public_hackers"
  | "backfill_hacker_address"
  | "audit_hacker_backfill"
  | "process_tx"
  | "poll_hacker_address"
  | "poll_downstream_address"
  | "expand_downstream"
  | "refresh_live_balance"
  | "refresh_btc_usd_price"
  | "sync_coldcardwatch"
  | "sync_vercel_trackers";

export type EnvMap = Record<string, string | undefined>;

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
  btcUsdPriceRefreshIntervalSec: number;
  coldcardwatchSyncIntervalSec: number;
  coldcardwatchBase: string;
  vercelTrackersSyncIntervalSec: number;
  coldcardSweepWatchBase: string;
  coldcardHackTrackerBase: string;
  monitoringStaleSec: number;
  apiThresholdCooldownSec: number;
  backfillTxsPerJob: number;
  backfillMaxTxs: number;
  backfillHealAuditIntervalSec: number;
  backfillHealAuditPerCron: number;
  backfillHealTxSlack: number;
  adminToken: string;
  seedFilePath: string;
  localWatchlistPath: string;
  /** Inline seed JSON for Workers (avoids filesystem). */
  seedDataJson: string | null;
  /** Inline local watchlist JSON for Workers. */
  localWatchlistDataJson: string | null;
  indexerRebuildMode: boolean;
  processTxRebuildPriority: number;
  /** Comma-separated CORS origins; empty = reflect request origin only when local defaults apply. */
  corsOrigins: string[];
  environment: string;
}

export function loadConfig(env: EnvMap = process.env as EnvMap): AppConfig {
  const corsRaw = env.CORS_ORIGINS?.trim();
  const corsOrigins = corsRaw
    ? corsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["http://localhost:5173", "http://127.0.0.1:5173"];

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
    btcUsdPriceRefreshIntervalSec: Number(env.BTC_USD_PRICE_REFRESH_INTERVAL_SEC ?? 60),
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
    apiThresholdCooldownSec: Number(env.API_THRESHOLD_COOLDOWN_SEC ?? 300),
    backfillTxsPerJob: Number(env.BACKFILL_TXS_PER_JOB ?? 5),
    backfillMaxTxs: Number(env.BACKFILL_MAX_TXS ?? 10000),
    backfillHealAuditIntervalSec: Number(env.BACKFILL_HEAL_AUDIT_INTERVAL_SEC ?? 86400),
    backfillHealAuditPerCron: Number(env.BACKFILL_HEAL_AUDIT_PER_CRON ?? 1),
    backfillHealTxSlack: Number(env.BACKFILL_HEAL_TX_SLACK ?? 5),
    adminToken: env.ADMIN_TOKEN ?? "change-me",
    seedFilePath: env.SEED_FILE ?? "./config/watchlist.seed.json",
    localWatchlistPath: env.LOCAL_WATCHLIST ?? "./config/watchlist.local.json",
    seedDataJson: env.SEED_DATA_JSON ?? null,
    localWatchlistDataJson: env.LOCAL_WATCHLIST_DATA_JSON ?? null,
    indexerRebuildMode: env.INDEXER_REBUILD_MODE === "1",
    processTxRebuildPriority: Number(env.PROCESS_TX_REBUILD_PRIORITY ?? JOB_PRIORITY.PROCESS_TX_REBUILD),
    corsOrigins,
    environment: env.ENVIRONMENT ?? env.NODE_ENV ?? "development",
  };
}

/** Refuse insecure default admin token when running as production. */
export function assertProductionSecrets(config: AppConfig): void {
  if (config.environment !== "production") return;
  if (!config.adminToken || config.adminToken === "change-me") {
    throw new Error("ADMIN_TOKEN must be set to a non-default value in production");
  }
}
