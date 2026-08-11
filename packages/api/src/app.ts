import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Store } from "@cointrace/db";
import type { AppConfig } from "@cointrace/core";
import {
  buildGraph,
  buildVictimGraph,
  isRebuildActive,
  normalizeBitcoinAddress,
} from "@cointrace/core";
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

export function createApp(store: Store, config: AppConfig) {
  const app = new Hono();

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

  app.onError((err, c) => {
    console.error(err);
    if (config.environment === "production") {
      return c.json({ error: "internal error" }, 500);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET") return next();
    const path = new URL(c.req.url).pathname;
    if (path === "/api/health") return next();

    const ip = clientIp(c);
    if (path === "/api/graph") {
      const denied = await applyRateLimit(
        c,
        store,
        config,
        `get:graph:${ip}`,
        config.graphRateLimit,
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

  app.get("/api/config", (c) =>
    c.json({
      minEdgeSats: config.minEdgeSats,
      statsPollMs: config.btcUsdPriceRefreshIntervalSec * 1000,
      maxGraphVictims: config.maxGraphVictims,
      maxGraphDownstream: config.maxGraphDownstream,
    }),
  );

  app.get("/api/hackers", async (c) => {
    const q = c.req.query("q");
    const hackers = await store.listHackers(q, true);
    return c.json({
      hackers: hackers.map((h) => ({
        address: h.address,
        label: h.label,
        source: h.source,
        totalReceivedSats: h.totalReceivedSats,
        liveBalanceSats: h.liveBalanceSats,
        liveBalanceAt: h.liveBalanceAt,
      })),
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
    const scheduler = await store.getSchedulerState();
    const crawl = await store.getCrawlStats();
    const monitor = await store.getDownstreamMonitorStats(config.maxCrawlDepth, config.downstreamPollIntervalSec);
    const monitoring = await store.getMonitoringStatus(config.monitoringStaleSec, config.apiThresholdCooldownSec);
    return c.json({
      queueDepth: await store.getQueueDepth(),
      nextApiCallAt: scheduler?.nextProviderCallAt ?? null,
      rateLimitMs: scheduler?.rateLimitMs ?? config.rateLimitMs,
      lastProviderUsed: scheduler?.lastProviderUsed ?? null,
      rebuildActive: await isRebuildActive(store, config),
      pendingProcessTx: await store.countActiveJobs("process_tx"),
      ...crawl,
      ...monitor,
      ...monitoring,
    });
  });

  return app;
}
