import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Store } from "@cointrace/db";
import type { AppConfig } from "@cointrace/core";
import { buildGraph, buildVictimGraph, computeJobEta, isRebuildActive, JOB_PRIORITY } from "@cointrace/core";

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

export function createApp(store: Store, config: AppConfig) {
  const app = new Hono();

  app.use("*", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/config", (c) => c.json({ minEdgeSats: config.minEdgeSats }));

  app.get("/api/hackers", (c) => {
    const q = c.req.query("q");
    const hackers = store.listHackers(q, true);
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

  app.get("/api/graph", (c) => {
    const depth = Number(c.req.query("depth") ?? config.maxGraphDepth);
    const expandVictims = c.req.query("expand_victims") === "1";
    const minEdgeSats = parseMinEdgeSats(c.req.query("min_edge_sats"), config.minEdgeSats);
    const victim = c.req.query("victim")?.trim().toLowerCase();
    const hacker = c.req.query("hacker");

    const graphOpts = {
      depth,
      expandVictims,
      maxVictims: parsePositiveInt(c.req.query("max_victims"), 100),
      maxOutputs: parsePositiveInt(c.req.query("max_downstream"), 100),
      minEdgeSats,
    };

    if (victim) {
      const hackers = store.listHackersForVictim(victim, minEdgeSats);
      if (hackers.length === 0) return c.json({ error: "victim not found" }, 404);
      if (hackers.length === 1) {
        return c.json(
          buildGraph(store, hackers[0]!.address, { ...graphOpts, victimFilter: victim, expandVictims: false }),
        );
      }
      return c.json(buildVictimGraph(store, victim, { minEdgeSats }));
    }

    if (!hacker) return c.json({ error: "hacker query required" }, 400);
    return c.json(buildGraph(store, hacker, graphOpts));
  });

  app.get("/api/addresses/:addr", (c) => {
    const detail = store.getAddressDetail(c.req.param("addr"));
    if (!detail) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/stats", (c) => {
    return c.json(store.getStats());
  });

  app.get("/api/sync/status", (c) => {
    const scheduler = store.getSchedulerState();
    const crawl = store.getCrawlStats();
    const monitor = store.getDownstreamMonitorStats(config.maxCrawlDepth, config.downstreamPollIntervalSec);
    const monitoring = store.getMonitoringStatus(config.monitoringStaleSec, config.apiThresholdCooldownSec);
    return c.json({
      queueDepth: store.getQueueDepth(),
      nextApiCallAt: scheduler?.nextProviderCallAt ?? null,
      rateLimitMs: scheduler?.rateLimitMs ?? config.rateLimitMs,
      lastProviderUsed: scheduler?.lastProviderUsed ?? null,
      rebuildActive: isRebuildActive(store, config),
      pendingProcessTx: store.countActiveJobs("process_tx"),
      ...crawl,
      ...monitor,
      ...monitoring,
    });
  });

  app.get("/api/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    const job = store.getJob(id);
    if (!job) return c.json({ error: "not found" }, 404);
    const eta = computeJobEta(store, job, config.rateLimitMs, config.jobsPerTick);
    return c.json({
      id: job.id,
      type: job.type,
      status: job.status,
      ...eta,
    });
  });

  app.post("/api/expand/:addr", (c) => {
    const address = c.req.param("addr");
    const addr = store.getAddress(address);
    if (!addr) return c.json({ error: "address not in database" }, 404);
    if (store.hasPendingJob("expand_downstream", address)) {
      return c.json({ error: "expand already queued" }, 409);
    }
    store.setExpandStatus(address, "queued");
    const jobId = store.enqueueJob("expand_downstream", { address, user: true }, JOB_PRIORITY.USER_EXPAND);
    const job = store.getJob(jobId)!;
    const eta = computeJobEta(store, job, config.rateLimitMs, config.jobsPerTick);
    return c.json({
      jobId,
      status: "queued",
      ...eta,
    });
  });

  app.post("/api/admin/hackers", async (c) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${config.adminToken}`) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json<{ address?: string; label?: string }>();
    if (!body.address?.trim()) return c.json({ error: "address required" }, 400);
    store.upsertAddress({
      address: body.address.trim(),
      role: "hacker",
      label: body.label ?? null,
      source: "admin",
      isFlaggedHacker: true,
      hopFromHacker: 0,
    });
    store.enqueueJob("backfill_hacker_address", { address: body.address.trim() }, JOB_PRIORITY.BACKFILL_HACKER);
    return c.json({ ok: true });
  });

  return app;
}
