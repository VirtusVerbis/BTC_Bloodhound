import { createD1Store } from "@cointrace/db/d1";
import { D1RowMeter } from "@cointrace/db";
import {
  assertProductionSecrets,
  ChainRouter,
  clearTickLeaseSafe,
  formatCronPaceSkipLine,
  formatUtcResetCountdown,
  loadConfig,
  logCronDetail,
  logCronError,
  runIndexerTick,
  shouldPaceCron,
  TICK_LEASE_SKEW_MS,
  type AppConfig,
  type EnvMap,
} from "@cointrace/core";
import type { Store } from "@cointrace/db";
import { createApp } from "./app.js";

export interface WorkerEnv {
  DB: {
    prepare(query: string): unknown;
    batch?<T = unknown>(statements: unknown[]): Promise<T[]>;
    exec?(query: string): Promise<unknown>;
  };
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  CORS_ORIGINS?: string;
  ESPLORA_BASE?: string;
  MEMPOOL_BASE?: string;
  RATE_LIMIT_MS?: string;
  JOBS_PER_TICK?: string;
  TICK_BUDGET_MS?: string;
  RUNNING_JOB_STALE_MS?: string;
  SEED_DATA_JSON?: string;
  LOCAL_WATCHLIST_DATA_JSON?: string;
  [key: string]: unknown;
}

function envMap(env: WorkerEnv): EnvMap {
  const map: EnvMap = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") map[k] = v;
  }
  if (!map.ENVIRONMENT) map.ENVIRONMENT = env.ENVIRONMENT ?? "production";
  return map;
}

function quotaLimits(config: AppConfig) {
  return {
    rowsReadLimit: config.d1ReadDailyLimit,
    rowsWrittenLimit: config.d1WriteDailyLimit,
    workersRequestsLimit: config.workersRequestDailyLimit,
  };
}

function buildIndexer(
  env: WorkerEnv,
  d1RowMeter?: D1RowMeter,
): {
  config: AppConfig;
  store: Store;
  router: ChainRouter;
} {
  const config = loadConfig(envMap(env));
  assertProductionSecrets(config);
  const store = createD1Store(env.DB, {
    maxQueueDepth: config.maxQueueDepth,
    d1BatchSize: config.d1BatchSize,
    d1RowMeter,
  });
  const router = new ChainRouter(config.esploraBase, config.mempoolBase, store, config.rateLimitMs, {
    sleepOnRateLimit: false,
    primaryProvider: config.chainPrimaryProvider,
    backoff: {
      rateLimitMs: config.rateLimitMs,
      apiThresholdBaseSec: config.apiThresholdBaseSec,
      apiThresholdMaxSec: config.apiThresholdMaxSec,
    },
  });
  return { config, store, router };
}

function buildApp(env: WorkerEnv, d1RowMeter?: D1RowMeter) {
  const { config, store, router } = buildIndexer(env, d1RowMeter);
  const app = createApp(store, config, { d1RowMeter });
  return { config, store, router, app };
}

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://mempool.space",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function flushCronQuota(
  store: Store,
  d1RowMeter: D1RowMeter,
  meterStart: { rowsRead: number; rowsWritten: number },
): Promise<void> {
  d1RowMeter.rolloverIfNeeded();
  const snap = d1RowMeter.snapshot();
  await store.flushQuotaUsage("cron", {
    reads: snap.rowsRead - meterStart.rowsRead,
    writes: snap.rowsWritten - meterStart.rowsWritten,
    requests: 1,
  });
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const d1RowMeter = new D1RowMeter();
    const { app } = buildApp(env, d1RowMeter);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }
    if (env.ASSETS) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }
    return withSecurityHeaders(new Response("Not found", { status: 404 }));
  },

  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const d1RowMeter = new D1RowMeter();
    const { store, router, config } = buildIndexer(env, d1RowMeter);
    try {
      if (await store.isCronIndexerPaused()) return;

      const snapshot = await store.getQuotaSnapshot();
      const pace = shouldPaceCron(snapshot, quotaLimits(config), {
        cronUtilizationPct: config.cronQuotaUtilizationPct,
      });
      if (pace.paced) {
        logCronDetail(
          config.indexerJobDetails,
          formatCronPaceSkipLine(pace, snapshot, formatUtcResetCountdown()),
          config.indexerLogColor,
        );
        return;
      }

      const leaseMs = config.tickBudgetMs + TICK_LEASE_SKEW_MS;
      const acquired = await store.tryAcquireTickLease(leaseMs);
      if (!acquired) return;

      d1RowMeter.rolloverIfNeeded();
      const meterStart = d1RowMeter.snapshot();
      try {
        await store.resetRunningJobs(config.runningJobStaleMs, {
          jobReclaimDeferAfter: config.jobReclaimDeferAfter,
          jobReclaimDeferSec: config.jobReclaimDeferSec,
        });
        await runIndexerTick(store, router, config, {
          schedule: true,
          jobDetails: config.indexerJobDetails,
        });
      } finally {
        try {
          await flushCronQuota(store, d1RowMeter, meterStart);
        } catch (err) {
          logCronError(`[cron] flushQuotaUsage failed: ${String(err)}`, config.indexerLogColor);
        }
        await clearTickLeaseSafe(store, (msg) =>
          logCronError(`[cron] clearTickLease failed: ${msg}`, config.indexerLogColor),
        );
      }
    } catch (err) {
      logCronError(`[cron] scheduled failed: ${String(err)}`, config.indexerLogColor);
    }
  },
};

export default worker;
