import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { IndexerLogColorMode } from "./indexer/logColor.js";

export const JOB_PRIORITY = {
  PROCESS_TX_REBUILD: 11,
  BACKFILL_HACKER: 10,
  CRON_EXPAND: 5,
  POLL_HACKER: 6,
  POLL_DOWNSTREAM: 5,
  PROCESS_TX: 4,
  SYNC_COLDCARDWATCH: 3,
  SYNC_VERCEL_TRACKERS: 3,
  REFRESH_BALANCE: 2,
  REFRESH_BTC_USD: 1,
} as const;

export type JobType =
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
  /** Cold-start chain provider when lastProviderUsed is unset. */
  chainPrimaryProvider: "esplora" | "mempool";
  rateLimitMs: number;
  jobsPerTick: number;
  /** Wall-clock budget for one indexer tick (stop claiming jobs after this). */
  tickBudgetMs: number;
  /** Only reclaim running jobs whose started_at is older than this (0 = all). */
  runningJobStaleMs: number;
  cronIntervalSec: number;
  crawlEnqueuePerCron: number;
  pollHackerEnqueuePerCron: number;
  hackerMaintenanceEveryNCrons: number;
  downstreamPollIntervalSec: number;
  downstreamPollEnqueuePerCron: number;
  maxCrawlDepth: number;
  maxGraphDepth: number;
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
  apiThresholdBaseSec: number;
  apiThresholdMaxSec: number;
  backfillTxsPerJob: number;
  /** Max chain API calls per job (0 = unlimited / legacy local behavior). */
  maxChainCallsPerJob: number;
  backfillMaxTxs: number;
  backfillHealAuditIntervalSec: number;
  backfillHealAuditPerCron: number;
  backfillHealTxSlack: number;
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
  /** True when CORS_ORIGINS env was explicitly set (required in production). */
  corsOriginsFromEnv: boolean;
  environment: string;
  getRateLimit: number;
  getRateWindowSec: number;
  graphRateLimit: number;
  graphRateWindowSec: number;
  graphContinuationRateLimit: number;
  graphPageSizeDefault: number;
  graphPageSizeMax: number;
  maxGraphVictims: number;
  maxGraphDownstream: number;
  /** Top N hacker addresses in global recent-activity cache. */
  recentHackersLimit: number;
  /** Client poll interval for /api/hackers (ms). */
  hackersPollMs: number;
  /** Client poll interval while cron_indexer_paused=1 (sidecar drain). */
  hackersPollMsSidecar: number;
  /** Pause cron/discovery enqueue when pending queue reaches this depth. */
  maxQueueDepth: number;
  /** Clear queueSchedulingPaused latch when pending depth is at or below this. */
  queueSchedulingResumeDepth: number;
  /** Run jobs before schedule when queue depth is at or above this (default 1). */
  queueDrainFirstDepth: number;
  /** Burst ceiling for jobs processed per tick when queue is deep. */
  jobsPerTickMax: number;
  /** Add one extra job per tick for every N queue depth above base. */
  queueDepthPerExtraJob: number;
  /** Zero out crawl/poll schedule enqueue when queue depth reaches this (soft backpressure). */
  queueSoftThrottleDepth: number;
  /** Opt-in verbose cron/job console logging ([cron] tick start, [job] start, etc.). */
  indexerJobDetails: boolean;
  /** ANSI-colorize indexer log prefixes and key labels in console output. */
  indexerLogColor: boolean;
  /** Log color scheme: default (rainbow labels) or sidecar (white/grey, red errors). */
  indexerLogColorMode: IndexerLogColorMode;
  /** Sidecar heartbeat interval in seconds. */
  sidecarHeartbeatSec: number;
  /** Defer ingest jobs after this many consecutive RateLimitNotReadyError failures. */
  jobDeferAfterAttempts: number;
  /** How long deferred ingest jobs stay out of the claim queue (seconds). */
  jobDeferSec: number;
  /** Cloudflare subrequests per Worker invocation (0 = unlimited). */
  subrequestLimitPerInvocation: number;
  /** Reserve subrequests for schedule phase + tick overhead. */
  scheduleSubrequestReserve: number;
  /** Extra schedule reserve on hacker maintenance ticks. */
  scheduleReserveMaintExtra: number;
  /** Stop a job after this many subrequests; continue next tick. */
  maxSubrequestsPerJob: number;
  /** Max graph edges applied per job chunk. */
  maxEdgesPerJob: number;
  /** CPU guard: cap edges computed per tx. */
  maxGraphEdgesPerTx: number;
  /** Peel relay: min receive ratio on first page. */
  sweepRelayMinReceiveRatio: number;
  sweepRelayMinVoutCount: number;
  sweepRelayMinSpendTargetShare: number;
  /** Spend fanout detection thresholds. */
  spendFanoutMinVoutCount: number;
  spendFanoutMinOutputAddresses: number;
  spendFanoutTopK: number;
  /** Graph bundling threshold for peel relay edges. */
  graphBundleMinEdges: number;
  /** Reclaim poison pill after N stale reclaims without progress. */
  jobReclaimDeferAfter: number;
  /** How long reclaimed-without-progress ingest jobs stay deferred (seconds). */
  jobReclaimDeferSec: number;
  /** Max classified receive txs skipped per backfill job tick (no D1 per tx). */
  backfillSkipReceivesPerJob: number;
  /** Trace receive/deposit txs for flagged hackers at hop 0 (victim→hacker edges). */
  traceFlaggedHackerReceives: boolean;
  /** Skip getTx when receive-only tx has more than this many outputs. */
  maxVoutCountSkipGetTx: number;
  /** Max D1 statements per batch() call. */
  d1BatchSize: number;
  /** Source sync addresses processed per job chunk. */
  syncAddressesPerJob: number;
  /** Cumulative sync-CPU budget per job (ms); 0 = disabled. */
  jobCpuGuardMs: number;
  /** Max share of daily D1/request quota cron may consume (0–100). */
  cronQuotaUtilizationPct: number;
  d1ReadDailyLimit: number;
  d1WriteDailyLimit: number;
  workersRequestDailyLimit: number;
  /** Max pending+running expand_downstream jobs per address. */
  maxPendingExpandPerAddress: number;
  /** Max pending+running expand_downstream jobs account-wide. */
  maxPendingExpandGlobal: number;
  /** Every N maintenance cron ticks, ingest slot 0 skips ingest pick (poll slice). */
  pollSliceEveryNCrons: number;
  /** When true, maint/cosmetic jobs gain effective priority while waiting in queue. */
  ageBoostEnabled: boolean;
  /** Seconds of wait per +1 effective priority boost (maint/cosmetic only). */
  ageBoostIntervalSec: number;
  /** Max priority points added by age boost. */
  ageBoostMax: number;
  /** Every N maintenance cron ticks, slot 0 may force-claim oldest eligible maint/cosmetic job. */
  maintSliceEveryNCrons: number;
  /** Min wait (seconds) before a job is eligible for maint-slice force claim. */
  maintSliceMinWaitSec: number;
}

let envFileLoaded = false;

function resolveEnvFilePath(): string {
  const override = process.env.DOTENV_CONFIG_PATH?.trim();
  if (override) return path.resolve(override);

  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), ".env");
}

/** Load repo-root `.env` into process.env (Node only; idempotent). */
export function loadEnvFile(): void {
  if (envFileLoaded) return;
  if (typeof process === "undefined" || !process.env) return;
  envFileLoaded = true;
  dotenv.config({ path: resolveEnvFilePath() });
}

/** @internal Reset for unit tests. */
export function resetLoadEnvFileForTests(): void {
  envFileLoaded = false;
}

export function loadConfig(env: EnvMap = process.env as EnvMap): AppConfig {
  if (env === (process.env as EnvMap)) {
    loadEnvFile();
  }
  const corsRaw = env.CORS_ORIGINS?.trim();
  const corsOriginsFromEnv = Boolean(corsRaw);
  const corsOrigins = corsRaw
    ? corsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["http://localhost:5173", "http://127.0.0.1:5173"];

  return {
    databaseUrl: env.DATABASE_URL ?? "file:./data/cointrace.db",
    esploraBase: (env.ESPLORA_BASE ?? "https://blockstream.info/api").replace(/\/$/, ""),
    mempoolBase: (env.MEMPOOL_BASE ?? "https://mempool.space/api").replace(/\/$/, ""),
    chainPrimaryProvider:
      env.CHAIN_PRIMARY_PROVIDER === "mempool" ? "mempool" : "esplora",
    rateLimitMs: Number(env.RATE_LIMIT_MS ?? 8000),
    jobsPerTick: Number(env.JOBS_PER_TICK ?? 1),
    tickBudgetMs: Number(env.TICK_BUDGET_MS ?? 50_000),
    runningJobStaleMs: Number(env.RUNNING_JOB_STALE_MS ?? 120_000),
    cronIntervalSec: Number(env.CRON_INTERVAL_SEC ?? 60),
    crawlEnqueuePerCron: Number(env.CRAWL_ENQUEUE_PER_CRON ?? 3),
    pollHackerEnqueuePerCron: Number(env.POLL_HACKER_ENQUEUE_PER_CRON ?? 1),
    hackerMaintenanceEveryNCrons: Number(env.HACKER_MAINTENANCE_EVERY_N_CRONS ?? 10),
    downstreamPollIntervalSec: Number(env.DOWNSTREAM_POLL_INTERVAL_SEC ?? 600),
    downstreamPollEnqueuePerCron: Number(env.DOWNSTREAM_POLL_ENQUEUE_PER_CRON ?? 2),
    maxCrawlDepth: Number(env.MAX_CRAWL_DEPTH ?? 5),
    maxGraphDepth: Number(env.MAX_GRAPH_DEPTH ?? 2),
    minEdgeSats: Number(env.MIN_EDGE_SATS ?? 1000),
    balanceRefreshIntervalSec: Number(env.BALANCE_REFRESH_INTERVAL_SEC ?? 300),
    btcUsdPriceRefreshIntervalSec: Number(env.BTC_USD_PRICE_REFRESH_INTERVAL_SEC ?? 900),
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
    apiThresholdBaseSec: Number(
      env.API_THRESHOLD_BASE_SEC ?? env.API_THRESHOLD_COOLDOWN_SEC ?? 300,
    ),
    apiThresholdMaxSec: Number(env.API_THRESHOLD_MAX_SEC ?? 3600),
    backfillTxsPerJob: Number(env.BACKFILL_TXS_PER_JOB ?? 5),
    maxChainCallsPerJob: Number(env.MAX_CHAIN_CALLS_PER_JOB ?? 0),
    backfillMaxTxs: Number(env.BACKFILL_MAX_TXS ?? 10000),
    backfillHealAuditIntervalSec: Number(env.BACKFILL_HEAL_AUDIT_INTERVAL_SEC ?? 86400),
    backfillHealAuditPerCron: Number(env.BACKFILL_HEAL_AUDIT_PER_CRON ?? 1),
    backfillHealTxSlack: Number(env.BACKFILL_HEAL_TX_SLACK ?? 5),
    seedFilePath: env.SEED_FILE ?? "./config/watchlist.seed.json",
    localWatchlistPath: env.LOCAL_WATCHLIST ?? "./config/watchlist.local.json",
    seedDataJson: env.SEED_DATA_JSON ?? null,
    localWatchlistDataJson: env.LOCAL_WATCHLIST_DATA_JSON ?? null,
    indexerRebuildMode: env.INDEXER_REBUILD_MODE === "1",
    processTxRebuildPriority: Number(env.PROCESS_TX_REBUILD_PRIORITY ?? JOB_PRIORITY.PROCESS_TX_REBUILD),
    corsOrigins,
    corsOriginsFromEnv,
    environment: env.ENVIRONMENT ?? env.NODE_ENV ?? "development",
    getRateLimit: Number(env.GET_RATE_LIMIT ?? 120),
    getRateWindowSec: Number(env.GET_RATE_WINDOW_SEC ?? 60),
    graphRateLimit: Number(env.GRAPH_RATE_LIMIT ?? 30),
    graphRateWindowSec: Number(env.GRAPH_RATE_WINDOW_SEC ?? 60),
    graphContinuationRateLimit: Number(env.GRAPH_CONTINUATION_RATE_LIMIT ?? 120),
    graphPageSizeDefault: Number(env.GRAPH_PAGE_SIZE_DEFAULT ?? 500),
    graphPageSizeMax: Number(env.GRAPH_PAGE_SIZE_MAX ?? 1000),
    maxGraphVictims: Number(env.MAX_GRAPH_VICTIMS ?? 10000),
    maxGraphDownstream: Number(env.MAX_GRAPH_DOWNSTREAM ?? 10000),
    recentHackersLimit: Math.max(1, Number(env.RECENT_HACKERS_LIMIT ?? 5)),
    hackersPollMs: Math.max(3_600_000, Number(env.HACKERS_POLL_MS ?? 3_600_000)),
    hackersPollMsSidecar: Math.max(60_000, Number(env.HACKERS_POLL_MS_SIDECAR ?? 60_000)),
    maxQueueDepth: Number(env.MAX_QUEUE_DEPTH ?? 360),
    queueSchedulingResumeDepth:
      env.QUEUE_SCHEDULING_RESUME_DEPTH != null &&
      Number.isFinite(Number(env.QUEUE_SCHEDULING_RESUME_DEPTH))
        ? Number(env.QUEUE_SCHEDULING_RESUME_DEPTH)
        : Math.floor(Number(env.MAX_QUEUE_DEPTH ?? 360) / 2),
    queueDrainFirstDepth: Number(env.QUEUE_DRAIN_FIRST_DEPTH ?? 1),
    jobsPerTickMax: Number(env.JOBS_PER_TICK_MAX ?? 3),
    queueDepthPerExtraJob: Number(env.QUEUE_DEPTH_PER_EXTRA_JOB ?? 40),
    queueSoftThrottleDepth: Number(env.QUEUE_SOFT_THROTTLE_DEPTH ?? 80),
    indexerJobDetails: env.INDEXER_JOB_DETAILS === "1",
    indexerLogColor: env.INDEXER_LOG_COLOR === "1",
    indexerLogColorMode: env.INDEXER_LOG_COLOR_MODE === "sidecar" ? "sidecar" : "default",
    sidecarHeartbeatSec: Math.max(5, Number(env.SIDECAR_HEARTBEAT_SEC ?? 30)),
    jobDeferAfterAttempts: Number(env.JOB_DEFER_AFTER_ATTEMPTS ?? 20),
    jobDeferSec: Number(env.JOB_DEFER_SEC ?? 86400),
    subrequestLimitPerInvocation: Number(env.SUBREQUEST_LIMIT_PER_INVOCATION ?? 0),
    scheduleSubrequestReserve: Number(env.SCHEDULE_SUBREQUEST_RESERVE ?? 38),
    scheduleReserveMaintExtra: Number(env.SCHEDULE_RESERVE_MAINT_EXTRA ?? 10),
    maxSubrequestsPerJob: Number(env.MAX_SUBREQUESTS_PER_JOB ?? 0),
    maxEdgesPerJob: Number(env.MAX_EDGES_PER_JOB ?? 0),
    maxGraphEdgesPerTx: Number(env.MAX_GRAPH_EDGES_PER_TX ?? 0),
    sweepRelayMinReceiveRatio: Number(env.SWEEP_RELAY_MIN_RECEIVE_RATIO ?? 0.7),
    sweepRelayMinVoutCount: Number(env.SWEEP_RELAY_MIN_VOUT_COUNT ?? 20),
    sweepRelayMinSpendTargetShare: Number(env.SWEEP_RELAY_MIN_SPEND_TARGET_SHARE ?? 0.8),
    spendFanoutMinVoutCount: Number(env.SPEND_FANOUT_MIN_VOUT_COUNT ?? 20),
    spendFanoutMinOutputAddresses: Number(env.SPEND_FANOUT_MIN_OUTPUT_ADDRESSES ?? 10),
    spendFanoutTopK: Number(env.SPEND_FANOUT_TOP_K ?? 5),
    graphBundleMinEdges: Number(env.GRAPH_BUNDLE_MIN_EDGES ?? 2),
    jobReclaimDeferAfter: Number(env.JOB_RECLAIM_DEFER_AFTER ?? 3),
    jobReclaimDeferSec: Number(env.JOB_RECLAIM_DEFER_SEC ?? 86400),
    backfillSkipReceivesPerJob: Number(env.BACKFILL_SKIP_RECEIVES_PER_JOB ?? 25),
    traceFlaggedHackerReceives: env.TRACE_FLAGGED_HACKER_RECEIVES !== "0",
    maxVoutCountSkipGetTx: Number(env.MAX_VOUT_COUNT_SKIP_GET_TX ?? 20),
    d1BatchSize: Number(env.D1_BATCH_SIZE ?? 8),
    syncAddressesPerJob: Number(env.SYNC_ADDRESSES_PER_JOB ?? 5),
    jobCpuGuardMs: Number(env.JOB_CPU_GUARD_MS ?? 0),
    cronQuotaUtilizationPct: Math.min(
      100,
      Math.max(0, Number(env.CRON_QUOTA_UTILIZATION_PCT ?? 100)),
    ),
    d1ReadDailyLimit: Math.max(1, Number(env.D1_READ_DAILY_LIMIT ?? 5_000_000)),
    d1WriteDailyLimit: Math.max(1, Number(env.D1_WRITE_DAILY_LIMIT ?? 100_000)),
    workersRequestDailyLimit: Math.max(1, Number(env.WORKERS_REQUEST_DAILY_LIMIT ?? 100_000)),
    maxPendingExpandPerAddress: Math.max(1, Number(env.MAX_PENDING_EXPAND_PER_ADDRESS ?? 2)),
    maxPendingExpandGlobal: Math.max(1, Number(env.MAX_PENDING_EXPAND_GLOBAL ?? 40)),
    pollSliceEveryNCrons: Math.max(1, Number(env.POLL_SLICE_EVERY_N_CRONS ?? 4)),
    ageBoostEnabled: env.AGE_BOOST_ENABLED !== "0",
    ageBoostIntervalSec: Math.max(1, Number(env.AGE_BOOST_INTERVAL_SEC ?? 900)),
    ageBoostMax: Math.max(0, Number(env.AGE_BOOST_MAX ?? 4)),
    maintSliceEveryNCrons: Math.max(0, Number(env.MAINT_SLICE_EVERY_N_CRONS ?? 10)),
    maintSliceMinWaitSec: Math.max(0, Number(env.MAINT_SLICE_MIN_WAIT_SEC ?? 3600)),
  };
}

/** Refuse insecure defaults when running as production. */
export function assertProductionSecrets(config: AppConfig): void {
  if (config.environment !== "production") return;
  if (!config.corsOriginsFromEnv || config.corsOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must be set explicitly in production");
  }
}
