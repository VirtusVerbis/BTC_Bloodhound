import type { Job, Store } from "@cointrace/db";
import type { AppConfig, JobType } from "../config.js";
import { JOB_PRIORITY } from "../config.js";
import { jobClassForType, isIngestContinuation } from "../indexer/jobClass.js";
import { isRebuildActive } from "../indexer/rebuildMode.js";

const ALL_JOB_TYPES = new Set<JobType>([
  "backfill_hacker_address",
  "audit_hacker_backfill",
  "process_tx",
  "poll_hacker_address",
  "poll_downstream_address",
  "expand_downstream",
  "refresh_live_balance",
  "refresh_btc_usd_price",
  "sync_coldcardwatch",
  "sync_vercel_trackers",
]);

const PRIORITY_NAME_BY_VALUE = Object.fromEntries(
  Object.entries(JOB_PRIORITY).map(([name, value]) => [value, name]),
) as Record<number, string>;

const DEFAULT_PRIORITY_BY_JOB_TYPE: Record<JobType, number> = {
  backfill_hacker_address: JOB_PRIORITY.BACKFILL_HACKER,
  audit_hacker_backfill: JOB_PRIORITY.BACKFILL_HACKER,
  expand_downstream: JOB_PRIORITY.CRON_EXPAND,
  poll_hacker_address: JOB_PRIORITY.POLL_HACKER,
  poll_downstream_address: JOB_PRIORITY.POLL_DOWNSTREAM,
  process_tx: JOB_PRIORITY.PROCESS_TX,
  sync_coldcardwatch: JOB_PRIORITY.SYNC_COLDCARDWATCH,
  sync_vercel_trackers: JOB_PRIORITY.SYNC_VERCEL_TRACKERS,
  refresh_live_balance: JOB_PRIORITY.REFRESH_BALANCE,
  refresh_btc_usd_price: JOB_PRIORITY.REFRESH_BTC_USD,
};

export function defaultPriorityForJobType(type: string): number {
  if (!isKnownJobType(type)) return 0;
  return DEFAULT_PRIORITY_BY_JOB_TYPE[type];
}

export type QueueStatusFilter = "active" | "pending" | "running" | "all";

export interface ListQueueOptions {
  status?: QueueStatusFilter;
  type?: string;
  limit?: number;
  nextCron?: boolean;
}

export interface ListQueueResult {
  ok: true;
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  };
  context: {
    rebuildActive: boolean;
    queueDepth: number;
    crawlPendingCount: number;
    downstreamPollDueCount: number;
    scheduler: {
      maintenanceCronCounter: number;
      hackerPollIndex: number;
      nextProviderCallAt: string | null;
    };
  };
  nextCron?: NextCronPreview;
  jobs: EnrichedQueueJob[];
  truncated: boolean;
}

export interface EnrichedQueueJob {
  id: number;
  type: string;
  status: string;
  priority: number;
  priorityName: string | null;
  jobClass: ReturnType<typeof jobClassForType>;
  runAfter: string;
  runAfterDue: boolean;
  createdAt: string;
  startedAt: string | null;
  attempts: number;
  lastError: string | null;
  details: Record<string, unknown>;
}

export interface NextCronPreview {
  note: string;
  expandDownstream: Array<{ address: string; expandStatus: string | null }>;
  pollDownstream: Array<{ address: string }>;
  syncColdcardwatch: boolean;
  syncVercelTrackers: boolean;
  hackerMaintenance: { address: string; wouldEnqueue: string[] } | null;
}

export function isKnownJobType(type: string): type is JobType {
  return ALL_JOB_TYPES.has(type as JobType);
}

function statusesForFilter(status: QueueStatusFilter): string[] {
  switch (status) {
    case "pending":
      return ["pending"];
    case "running":
      return ["running"];
    case "all":
    case "active":
    default:
      return ["pending", "running"];
  }
}

export function summarizeJobPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "backfill_hacker_address": {
      const pendingTxids = payload.pendingTxids;
      return {
        address: payload.address,
        continuation: isIngestContinuation(JSON.stringify(payload)),
        pendingTxidsCount: Array.isArray(pendingTxids) ? pendingTxids.length : 0,
        chainCursor: payload.chainCursor ?? null,
        pagesExhausted: payload.pagesExhausted ?? null,
        processedIndex: payload.processedIndex ?? null,
      };
    }
    case "audit_hacker_backfill":
      return { address: payload.address };
    case "poll_hacker_address":
    case "poll_downstream_address": {
      const pendingTxids = payload.pendingTxids;
      return {
        address: payload.address,
        continuation: isIngestContinuation(JSON.stringify(payload)),
        pendingTxidsCount: Array.isArray(pendingTxids) ? pendingTxids.length : 0,
        processedIndex: payload.processedIndex ?? null,
      };
    }
    case "refresh_live_balance":
      return { address: payload.address };
    case "expand_downstream": {
      const pendingTxids = payload.pendingTxids;
      return {
        address: payload.address,
        cron: payload.cron === true,
        continuation: isIngestContinuation(JSON.stringify(payload)),
        pendingTxidsCount: Array.isArray(pendingTxids) ? pendingTxids.length : 0,
        processedIndex: payload.processedIndex ?? null,
        chainCursor: payload.chainCursor ?? null,
        pagesExhausted: payload.pagesExhausted ?? null,
        traceEdgeIndex: payload.traceEdgeIndex ?? null,
        traceEdgesPending: payload.traceEdgesPending === true,
      };
    }
    case "process_tx":
      return { txid: payload.txid };
    case "sync_coldcardwatch":
    case "sync_vercel_trackers":
    case "refresh_btc_usd_price":
      return {};
    default:
      return { payload };
  }
}

export function enrichQueueJob(job: Job, nowMs = Date.now()): EnrichedQueueJob {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
  } catch {
    payload = { raw: job.payloadJson };
  }
  const runAfterMs = new Date(job.runAfter).getTime();
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    priority: job.priority,
    priorityName: PRIORITY_NAME_BY_VALUE[job.priority] ?? null,
    jobClass: jobClassForType(job.type),
    runAfter: job.runAfter,
    runAfterDue: Number.isFinite(runAfterMs) ? runAfterMs <= nowMs : true,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    attempts: job.attempts,
    lastError: job.lastError ?? null,
    details: summarizeJobPayload(job.type, payload),
  };
}

function buildSummary(rows: Array<{ status: string; type: string; count: number }>) {
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    total += count;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
    byType[row.type] = (byType[row.type] ?? 0) + count;
  }
  return { total, byStatus, byType };
}

async function previewMaintainOneHacker(
  store: Store,
  config: AppConfig,
  h: { address: string; liveBalanceAt?: string | null },
  ts: number,
): Promise<string[]> {
  const wouldEnqueue: string[] = [];
  const address = h.address;

  if (
    !(await store.hasPendingJob("backfill_hacker_address", address)) &&
    !(await store.hasPendingJob("audit_hacker_backfill", address))
  ) {
    const addr = await store.getAddress(address);
    const status = addr?.expandStatus ?? "pending";
    const backfill = await store.getBackfillState(address);

    if (status === "pending" || status === "backfilling") {
      wouldEnqueue.push("backfill_hacker_address");
    } else if (status === "expanded" && !backfill?.backfillComplete) {
      wouldEnqueue.push("backfill_hacker_address");
    } else if (status === "expanded" && backfill?.backfillComplete) {
      const lastAudit = backfill.lastBackfillAuditAt
        ? new Date(backfill.lastBackfillAuditAt).getTime()
        : 0;
      if (ts - lastAudit >= config.backfillHealAuditIntervalSec * 1000) {
        wouldEnqueue.push("audit_hacker_backfill");
      }
    }
  }

  const balanceAt = h.liveBalanceAt ? new Date(h.liveBalanceAt).getTime() : 0;
  if (
    ts - balanceAt >= config.balanceRefreshIntervalSec * 1000 &&
    !(await store.hasPendingJob("refresh_live_balance", address))
  ) {
    wouldEnqueue.push("refresh_live_balance");
  }

  const backfill = await store.getBackfillState(address);
  if (backfill?.backfillComplete) {
    const sync = await store.getSyncState(address);
    const lastPoll = sync?.lastPolledAt ? new Date(sync.lastPolledAt).getTime() : 0;
    if (
      ts - lastPoll >= config.cronIntervalSec * 1000 &&
      !(await store.hasPendingJob("poll_hacker_address", address))
    ) {
      wouldEnqueue.push("poll_hacker_address");
    }
  }

  return wouldEnqueue;
}

export async function previewNextCronEnqueue(store: Store, config: AppConfig): Promise<NextCronPreview> {
  const note =
    "Preview of what scheduleDownstreamCrawl would enqueue on next tick (capped by config); read-only, no jobs enqueued.";

  if (await isRebuildActive(store, config)) {
    return {
      note,
      expandDownstream: [],
      pollDownstream: [],
      syncColdcardwatch: false,
      syncVercelTrackers: false,
      hackerMaintenance: null,
    };
  }

  const ts = Date.now();

  const cwSync = await store.getSourceSync("coldcardwatch");
  const cwLast = cwSync?.lastSyncAt ? new Date(cwSync.lastSyncAt).getTime() : 0;
  const syncColdcardwatch =
    ts - cwLast >= config.coldcardwatchSyncIntervalSec * 1000 &&
    !(await store.hasPendingJob("sync_coldcardwatch"));

  const htSync = await store.getSourceSync("coldcard_hack_tracker");
  const swSync = await store.getSourceSync("coldcard_sweep_watch");
  const htLast = htSync?.lastSyncAt ? new Date(htSync.lastSyncAt).getTime() : 0;
  const swLast = swSync?.lastSyncAt ? new Date(swSync.lastSyncAt).getTime() : 0;
  const vtLast = Math.max(htLast, swLast);
  const syncVercelTrackers =
    ts - vtLast >= config.vercelTrackersSyncIntervalSec * 1000 &&
    !(await store.hasPendingJob("sync_vercel_trackers"));

  const scheduler = await store.getSchedulerState();
  const nextTick = (scheduler?.maintenanceCronCounter ?? 0) + 1;
  let hackerMaintenance: NextCronPreview["hackerMaintenance"] = null;
  if (nextTick % config.hackerMaintenanceEveryNCrons === 0) {
    const hackers = await store.listHackers();
    if (hackers.length > 0) {
      const idx = (await store.getHackerPollIndex()) % hackers.length;
      const hacker = hackers[idx]!;
      const wouldEnqueue = await previewMaintainOneHacker(store, config, hacker, ts);
      hackerMaintenance = { address: hacker.address, wouldEnqueue };
    }
  }

  const frontier = await store.getDownstreamFrontier(config.crawlEnqueuePerCron, config.maxCrawlDepth);
  const expandDownstream: NextCronPreview["expandDownstream"] = [];
  for (const row of frontier) {
    if (await store.hasPendingJob("expand_downstream", row.address)) continue;
    const addr = await store.getAddress(row.address);
    expandDownstream.push({ address: row.address, expandStatus: addr?.expandStatus ?? null });
  }

  const pollCandidates = await store.listDownstreamForPoll(
    config.downstreamPollEnqueuePerCron,
    config.maxCrawlDepth,
    config.downstreamPollIntervalSec,
  );
  const pollDownstream: NextCronPreview["pollDownstream"] = [];
  for (const row of pollCandidates) {
    if (await store.hasPendingJob("poll_downstream_address", row.address)) continue;
    pollDownstream.push({ address: row.address });
  }

  return {
    note,
    expandDownstream,
    pollDownstream,
    syncColdcardwatch,
    syncVercelTrackers,
    hackerMaintenance,
  };
}

export async function listQueue(store: Store, config: AppConfig, opts: ListQueueOptions = {}): Promise<ListQueueResult> {
  const status = opts.status ?? "active";
  const statuses = statusesForFilter(status);
  const type = opts.type;
  const limit = opts.limit ?? 200;

  if (type && !isKnownJobType(type)) {
    throw new Error(`Unknown job type: ${type}`);
  }

  const summaryRows = await store.getActiveJobSummary({ statuses, type });
  const summary = buildSummary(
    summaryRows.map((row) => ({
      status: row.status,
      type: row.type,
      count: Number(row.count ?? 0),
    })),
  );

  let jobs: EnrichedQueueJob[] = [];
  let truncated = false;
  if (limit > 0) {
    const totalMatching = await store.countActiveJobsMatching({ statuses, type });
    const jobRows = await store.listActiveJobs({ statuses, type, limit });
    truncated = totalMatching > jobRows.length;
    jobs = jobRows.map((job) => enrichQueueJob(job));
  }

  const rebuildActive = await isRebuildActive(store, config);
  const crawl = await store.getCrawlStats();
  const monitor = await store.getDownstreamMonitorStats(config.maxCrawlDepth, config.downstreamPollIntervalSec);
  const scheduler = await store.getSchedulerState();

  const result: ListQueueResult = {
    ok: true,
    summary,
    context: {
      rebuildActive,
      queueDepth: await store.getQueueDepth(),
      crawlPendingCount: crawl.crawlPendingCount,
      downstreamPollDueCount: monitor.downstreamPollDueCount,
      scheduler: {
        maintenanceCronCounter: scheduler?.maintenanceCronCounter ?? 0,
        hackerPollIndex: scheduler?.hackerPollIndex ?? 0,
        nextProviderCallAt: scheduler?.nextProviderCallAt ?? null,
      },
    },
    jobs,
    truncated,
  };

  if (opts.nextCron) {
    result.nextCron = await previewNextCronEnqueue(store, config);
  }

  return result;
}
