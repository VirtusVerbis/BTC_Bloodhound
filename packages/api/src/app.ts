import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { classifyD1Error, D1QuotaExceededError, type D1RowMeter, type Store } from "@cointrace/db";
import type { AppConfig } from "@cointrace/core";
import {
  buildGraph,
  buildGraphL1Page,
  buildGraphL2Page,
  buildVictimGraph,
  enrichQueueJob,
  isRebuildActive,
  listQueue,
  normalizeBitcoinAddress,
  resolveHackersPollMs,
  type EnrichedQueueJob,
} from "@cointrace/core";
import type { Job } from "@cointrace/db";
import {
  clampInt,
  clientIp,
  enforceRateLimit,
  rateLimitResponse,
  securityHeadersMiddleware,
} from "./security.js";

function parseMinEdgeSats(raw: string | undefined, fallback: number) {
  if (raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
    return Number(raw);
  }
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  if (raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 1) {
    return Math.floor(Number(raw));
  }
  return fallback;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidLoadId(loadId: string | undefined): loadId is string {
  return loadId != null && UUID_RE.test(loadId);
}

const D1_QUOTA_USER_MESSAGE =
  "Database temporarily unavailable. Please try again after midnight UTC.";

function quotaLimits(config: AppConfig) {
  return {
    rowsReadLimit: config.d1ReadDailyLimit,
    rowsWrittenLimit: config.d1WriteDailyLimit,
    workersRequestsLimit: config.workersRequestDailyLimit,
  };
}

async function d1QuotaResponse(store: Store, err: D1QuotaExceededError, config: AppConfig) {
  const retryAfterSec = Math.max(
    1,
    Math.ceil((new Date(err.retryAt).getTime() - Date.now()) / 1000),
  );
  void store.setD1QuotaPaused(err.kind, err.retryAt).catch(console.error);
  const usage = await store.getD1QuotaStatus(quotaLimits(config)).catch(() => null);
  return {
    body: {
      error: D1_QUOTA_USER_MESSAGE,
      code: "d1_quota_exceeded",
      kind: err.kind,
      retryAfterAt: err.retryAt,
      rowsRead: usage?.rowsRead ?? 0,
      rowsWritten: usage?.rowsWritten ?? 0,
      workersRequests: usage?.workersRequests ?? 0,
      rowsReadLimit: usage?.rowsReadLimit ?? config.d1ReadDailyLimit,
      rowsWrittenLimit: usage?.rowsWrittenLimit ?? config.d1WriteDailyLimit,
      workersRequestsLimit: usage?.workersRequestsLimit ?? config.workersRequestDailyLimit,
    },
    retryAfterSec,
  };
}

async function applyRateLimit(
  c: Context,
  store: Store,
  config: AppConfig,
  key: string,
  limit: number,
  windowSec: number,
) {
  // Per-IP request limits only in production (local Node / wrangler dev skip).
  if (config.environment !== "production") return null;
  const result = await enforceRateLimit(store, key, limit, windowSec);
  if (!result.allowed) {
    const rl = rateLimitResponse(result.retryAfterSec);
    return c.json(rl.body, rl.status, rl.headers);
  }
  return null;
}

export function createApp(store: Store, config: AppConfig, opts?: { d1RowMeter?: D1RowMeter }) {
  const app = new Hono();
  const d1RowMeter = opts?.d1RowMeter;

  app.use("*", securityHeadersMiddleware);

  const allowed = new Set(config.corsOrigins);
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return "";
        if (allowed.has(origin)) return origin;
        return "";
      },
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.onError(async (err, c) => {
    console.error(err);
    const quotaErr = err instanceof D1QuotaExceededError ? err : classifyD1Error(err);
    if (quotaErr) {
      const { body, retryAfterSec } = await d1QuotaResponse(store, quotaErr, config);
      return c.json(body, 503, { "Retry-After": String(retryAfterSec) });
    }
    if (config.environment === "production") {
      return c.json({ error: "internal error" }, 500);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", async (c, next) => {
    d1RowMeter?.rolloverIfNeeded();
    const meterStart = d1RowMeter
      ? { rowsRead: d1RowMeter.snapshot().rowsRead, rowsWritten: d1RowMeter.snapshot().rowsWritten }
      : null;
    try {
      await next();
    } finally {
      if (d1RowMeter && meterStart) {
        const snap = d1RowMeter.snapshot();
        void store
          .flushQuotaUsage("api", {
            reads: snap.rowsRead - meterStart.rowsRead,
            writes: snap.rowsWritten - meterStart.rowsWritten,
            requests: 1,
          })
          .catch(console.error);
      }
    }
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const path = new URL(c.req.url).pathname;
    if (path === "/api/health") return next();

    const ip = clientIp(c);
    if (path === "/api/graph") {
      const loadId = c.req.query("load_id")?.trim();
      const graphKey =
        isValidLoadId(loadId) && c.req.query("paginated") === "1"
          ? `get:graph:load:${loadId}`
          : `get:graph:${ip}`;
      const graphLimit =
        isValidLoadId(loadId) && c.req.query("paginated") === "1"
          ? config.graphContinuationRateLimit
          : config.graphRateLimit;
      const denied = await applyRateLimit(
        c,
        store,
        config,
        graphKey,
        graphLimit,
        config.graphRateWindowSec,
      );
      if (denied) return denied;
    }

    const denied = await applyRateLimit(
      c,
      store,
      config,
      `get:${ip}`,
      config.getRateLimit,
      config.getRateWindowSec,
    );
    if (denied) return denied;
    return next();
  });

  app.get("/api/config", async (c) => {
    const cronIndexerPaused = await store.isCronIndexerPaused();
    return c.json({
      minEdgeSats: config.minEdgeSats,
      statsPollMs: config.btcUsdPriceRefreshIntervalSec * 1000,
      maxGraphVictims: config.maxGraphVictims,
      maxGraphDownstream: config.maxGraphDownstream,
      graphPageSizeDefault: config.graphPageSizeDefault,
      graphPageSizeMax: config.graphPageSizeMax,
      recentHackersLimit: config.recentHackersLimit,
      hackersPollMs: resolveHackersPollMs(config, cronIndexerPaused),
      cronIndexerPaused,
    });
  });

  app.get("/api/hackers", async (c) => {
    const q = c.req.query("q");
    const hackers = await store.listHackers(q, true);
    const recentHackers = await store.getRecentHackersActivity();
    const recentByAddress = new Map(recentHackers.map((entry) => [entry.address, entry]));
    return c.json({
      recentHackers,
      hackers: hackers.map((h) => {
        const recent = recentByAddress.get(h.address);
        return {
          address: h.address,
          label: h.label,
          source: h.source,
          totalReceivedSats: h.totalReceivedSats,
          liveBalanceSats: h.liveBalanceSats,
          liveBalanceAt: h.liveBalanceAt,
          lastGraphActivityAt: h.lastGraphActivityAt ?? null,
          recentVictimCount: recent?.victims ?? 0,
          recentDownstreamCount: recent?.downstream ?? 0,
        };
      }),
    });
  });

  app.get("/api/graph", async (c) => {
    const depthRaw = Number(c.req.query("depth") ?? config.maxGraphDepth);
    if (!Number.isFinite(depthRaw) || depthRaw < 1) {
      return c.json({ error: "invalid depth" }, 400);
    }
    const depth = clampInt(depthRaw, 1, config.maxGraphDepth);

    const expandVictims = c.req.query("expand_victims") === "1";
    const minEdgeSats = parseMinEdgeSats(c.req.query("min_edge_sats"), config.minEdgeSats);

    const victimRaw = c.req.query("victim")?.trim();
    const victim = victimRaw ? normalizeBitcoinAddress(victimRaw) : null;
    if (victimRaw && !victim) return c.json({ error: "invalid victim address" }, 400);

    const hackerRaw = c.req.query("hacker");
    const hacker = hackerRaw ? normalizeBitcoinAddress(hackerRaw) : null;
    if (hackerRaw?.trim() && !hacker) return c.json({ error: "invalid hacker address" }, 400);

    const maxVictimsRaw = parsePositiveInt(c.req.query("max_victims"), 100);
    const maxOutputsRaw = parsePositiveInt(c.req.query("max_downstream"), 100);
    if (maxVictimsRaw > config.maxGraphVictims || maxOutputsRaw > config.maxGraphDownstream) {
      return c.json(
        {
          error: "graph limits exceeded",
          maxVictims: config.maxGraphVictims,
          maxDownstream: config.maxGraphDownstream,
        },
        400,
      );
    }

    const graphOpts = {
      depth,
      expandVictims,
      maxVictims: clampInt(maxVictimsRaw, 1, config.maxGraphVictims),
      maxOutputs: clampInt(maxOutputsRaw, 1, config.maxGraphDownstream),
      minEdgeSats,
      graphBundleMinEdges: config.graphBundleMinEdges,
    };

    if (victim) {
      // Victim search: ignore min_edge_sats / max_victims for resolving and drawing the victim.
      const hackers = await store.listHackersForVictim(victim);
      if (hackers.length === 0) return c.json({ error: "victim not found" }, 404);
      if (hackers.length === 1) {
        return c.json(
          await buildGraph(store, hackers[0]!.address, { ...graphOpts, victimFilter: victim, expandVictims: false }),
        );
      }
      return c.json(await buildVictimGraph(store, victim));
    }

    if (!hacker) return c.json({ error: "hacker query required" }, 400);

    const paginated = c.req.query("paginated") === "1";
    if (paginated) {
      const phase = c.req.query("phase") === "l2" ? "l2" : "l1";
      const limitRaw = parsePositiveInt(c.req.query("limit"), config.graphPageSizeDefault);
      const limit = clampInt(limitRaw, 1, config.graphPageSizeMax);
      const cursor = c.req.query("cursor")?.trim() || null;
      const loadIdParam = c.req.query("load_id")?.trim();
      const maxDownstream = clampInt(maxOutputsRaw, 1, config.maxGraphDownstream);

      if (phase === "l2") {
        const l2Token = c.req.query("l2_token")?.trim();
        if (!l2Token) return c.json({ error: "l2_token required for phase=l2" }, 400);
        const loadedL2Raw = c.req.query("loaded_l2");
        const loadedL2 =
          loadedL2Raw != null && Number.isFinite(Number(loadedL2Raw))
            ? Math.max(0, Math.floor(Number(loadedL2Raw)))
            : 0;
        try {
          return c.json(
            await buildGraphL2Page(store, l2Token, {
              limit,
              cursor,
              loadedL2,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("invalid")) return c.json({ error: message }, 400);
          throw err;
        }
      }

      const loadedL1Raw = c.req.query("loaded_l1");
      const loadedL1 =
        loadedL1Raw != null && Number.isFinite(Number(loadedL1Raw))
          ? Math.max(0, Math.floor(Number(loadedL1Raw)))
          : 0;
      const loadId = cursor ? loadIdParam : crypto.randomUUID();
      if (cursor && !isValidLoadId(loadIdParam)) {
        return c.json({ error: "load_id required for continuation" }, 400);
      }
      try {
        const result = await buildGraphL1Page(store, hacker, {
          limit,
          cursor,
          loadedL1,
          maxDownstream,
          minEdgeSats,
          expandVictims,
          maxVictims: clampInt(maxVictimsRaw, 1, config.maxGraphVictims),
          graphBundleMinEdges: config.graphBundleMinEdges,
          maxGraphDepth: config.maxGraphDepth,
          loadId: loadId ?? undefined,
        });
        if (!cursor && result.page.loadId == null && loadId) {
          result.page.loadId = loadId;
        }
        return c.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("invalid")) return c.json({ error: message }, 400);
        throw err;
      }
    }

    return c.json(await buildGraph(store, hacker, graphOpts));
  });

  app.get("/api/addresses/:addr", async (c) => {
    const address = normalizeBitcoinAddress(c.req.param("addr"));
    if (!address) return c.json({ error: "invalid address" }, 400);
    const detail = await store.getAddressDetail(address);
    if (!detail) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/stats", async (c) => {
    return c.json(await store.getStats());
  });

  app.get("/api/sync/status", async (c) => {
    let scheduler: Awaited<ReturnType<Store["getSchedulerState"]>>;
    try {
      scheduler = await store.getSchedulerState();
    } catch (err) {
      console.error("sync/status getSchedulerState failed", err);
      scheduler = undefined;
    }

    let crawl = { crawlPendingCount: 0, crawlExpandedCount: 0, crawlMaxHopReached: 0 };
    try {
      crawl = await store.getCrawlStats();
    } catch (err) {
      console.error("sync/status getCrawlStats failed", err);
    }

    let monitor = { treeNodeCount: 0, downstreamPollDueCount: 0 };
    try {
      monitor = await store.getDownstreamMonitorStats(
        config.maxCrawlDepth,
        config.downstreamPollIntervalSec,
      );
    } catch (err) {
      console.error("sync/status getDownstreamMonitorStats failed", err);
    }

    let monitoring: Awaited<ReturnType<Store["getMonitoringStatus"]>>;
    try {
      monitoring = await store.getMonitoringStatus(
        config.monitoringStaleSec,
        config.apiThresholdCooldownSec,
      );
    } catch (err) {
      console.error("sync/status getMonitoringStatus failed", err);
      monitoring = {
        lastChainApiAt: null,
        lastExternalSyncAt: null,
        lastJobAt: null,
        lastCompletedJobType: null,
        lastCompletedJobDurationMs: null,
        lastCompletedJobAt: null,
        lastActivityAt: null,
        monitoringActive: false,
        apiThresholdExceeded: false,
        lastApiThresholdAt: null,
        apiThresholdCount: 0,
        apiThresholdCooldownSec: config.apiThresholdCooldownSec,
        apiThresholdSecondsLeft: 0,
        chainApis: [],
        queueSchedulingPaused: false,
        maxQueueDepth: config.maxQueueDepth,
        externalSources: [],
      };
    }

    let queueDepth = 0;
    let pendingQueueDepthAll = 0;
    let d1Quota = {
      readRetryAfterAt: null as string | null,
      writeRetryAfterAt: null as string | null,
      blocked: false,
      rowsRead: 0,
      rowsWritten: 0,
      workersRequests: 0,
      rowsReadLimit: config.d1ReadDailyLimit,
      rowsWrittenLimit: config.d1WriteDailyLimit,
      workersRequestsLimit: config.workersRequestDailyLimit,
    };
    try {
      queueDepth = await store.getQueueDepth();
      pendingQueueDepthAll = await store.getPendingQueueDepthAll();
      d1Quota = await store.getD1QuotaStatus(quotaLimits(config));
    } catch (err) {
      console.error("sync/status getQueueDepth failed", err);
    }

    let rebuildActive = false;
    try {
      rebuildActive = await isRebuildActive(store, config);
    } catch (err) {
      console.error("sync/status isRebuildActive failed", err);
    }

    let pendingProcessTx = 0;
    try {
      pendingProcessTx = await store.countActiveJobs("process_tx");
    } catch (err) {
      console.error("sync/status countActiveJobs failed", err);
    }

    return c.json({
      queueDepth,
      pendingQueueDepthAll,
      d1Quota,
      nextApiCallAt: scheduler?.nextProviderCallAt ?? null,
      rateLimitMs: scheduler?.rateLimitMs ?? config.rateLimitMs,
      lastProviderUsed: scheduler?.lastProviderUsed ?? null,
      rebuildActive,
      pendingProcessTx,
      ...crawl,
      ...monitor,
      ...monitoring,
    });
  });

  function sortQueueJobs(jobs: Job[]): Job[] {
    return [...jobs].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.runAfter.localeCompare(b.runAfter);
    });
  }

  app.get("/api/queue", async (c) => {
    const limit = clampInt(Number(c.req.query("limit") ?? 10), 1, 25);
    try {
      const base = await listQueue(store, config, { limit: 0 });
      const runningRows = sortQueueJobs(
        await store.listActiveJobs({ statuses: ["running"], limit }),
      );
      const pendingLimit = Math.max(0, limit - runningRows.length);
      const pendingRows = sortQueueJobs(
        await store.listActiveJobs({ statuses: ["pending"], limit: pendingLimit }),
      );
      const merged = [...runningRows, ...pendingRows];
      const jobs: EnrichedQueueJob[] = merged.map((job) => enrichQueueJob(job));
      const totalMatching = await store.countActiveJobsMatching({
        statuses: ["pending", "running"],
      });
      const scheduler = await store.getSchedulerState();
      return c.json({
        summary: base.summary,
        context: {
          ...base.context,
          queueSchedulingPaused: (scheduler?.queueSchedulingPaused ?? 0) !== 0,
        },
        jobs,
        truncated: totalMatching > jobs.length,
      });
    } catch (err) {
      console.error("queue list failed", err);
      return c.json({ error: "failed to load queue" }, 500);
    }
  });

  return app;
}
