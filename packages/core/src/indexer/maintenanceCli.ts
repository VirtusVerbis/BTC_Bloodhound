import type { MaintenancePhase, MaintenanceRunProgress, MaintenanceWorkEstimate, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { runScheduledMaintenance } from "./maintenance.js";
import { createUnlimitedSubrequestBudget } from "./subrequestBudget.js";

export interface MaintenanceCliProgress {
  phase: MaintenancePhase | "complete" | "idle";
  pct: number;
  etaSec: number | null;
  done: number;
  total: number;
  estimate: MaintenanceWorkEstimate;
  session: {
    backfillUpdated: number;
    jobsDeleted: number;
    rateLimitsDeleted: number;
    syncStateOrphansDeleted: number;
  };
}

export interface MaintenanceCliResult {
  ok: boolean;
  aborted: boolean;
  complete: boolean;
  iterations: number;
  session: MaintenanceCliProgress["session"];
  lastPhase?: MaintenancePhase | "complete";
}

export interface MaintenanceCliOpts {
  dryRun?: boolean;
  tickMs?: number;
  onProgress?: (progress: MaintenanceCliProgress) => void;
  signal?: AbortSignal;
}

const DEFAULT_TICK_MS = 25_000;
const ETA_WINDOW_MS = 30_000;

function computeProgressPct(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.floor((done / total) * 100));
}

function parseProgress(raw: string | null | undefined): MaintenanceRunProgress | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MaintenanceRunProgress;
  } catch {
    return null;
  }
}

function cumulativeFromProgress(progress: MaintenanceRunProgress | null): MaintenanceCliProgress["session"] {
  return {
    backfillUpdated: progress?.completedAtBackfillUpdated ?? 0,
    jobsDeleted: progress?.jobsDeleted ?? 0,
    rateLimitsDeleted: progress?.rateLimitsDeleted ?? 0,
    syncStateOrphansDeleted: progress?.syncStateOrphansDeleted ?? 0,
  };
}

function sessionDone(session: MaintenanceCliProgress["session"]): number {
  return (
    session.backfillUpdated +
    session.jobsDeleted +
    session.rateLimitsDeleted +
    session.syncStateOrphansDeleted
  );
}

function formatEta(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "?";
  const s = Math.ceil(sec);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  const rem = s % 60;
  if (min < 60) return `${min}m${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

export function formatMaintenanceCliLine(progress: MaintenanceCliProgress): string {
  const e = progress.estimate;
  const s = progress.session;
  const phase = progress.phase === "complete" ? "done" : progress.phase;
  const eta = formatEta(progress.etaSec);
  return (
    `Maintenance ${phase}  ${progress.pct}%  ETA ~${eta}  ` +
    `(backfill ${s.backfillUpdated}/${e.backfill}, jobs ${s.jobsDeleted}/${e.pruneJobs}, ` +
    `rate_limits ${s.rateLimitsDeleted}/${e.rateLimits}, sync_orphans ${s.syncStateOrphansDeleted}/${e.syncOrphans})`
  );
}

function phaseLabel(progress: MaintenanceRunProgress | null): MaintenancePhase | "complete" | "idle" {
  if (!progress?.phase) return "idle";
  return progress.phase;
}

function estimateEta(
  startedAtMs: number,
  doneAtStart: number,
  doneNow: number,
  total: number,
): number | null {
  const processed = doneNow - doneAtStart;
  if (processed <= 0 || total <= doneNow) return null;
  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  if (elapsedSec <= 0) return null;
  const rate = processed / elapsedSec;
  if (rate <= 0) return null;
  return (total - doneNow) / rate;
}

export async function runMaintenanceCli(
  store: Store,
  config: AppConfig,
  opts: MaintenanceCliOpts = {},
): Promise<MaintenanceCliResult> {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const budget = createUnlimitedSubrequestBudget();
  const forceDueCounter = Math.max(1, config.jobPruneIntervalDays) * 1440;

  const estimate = await store.estimateMaintenanceWork({
    jobDoneRetentionDays: config.jobDoneRetentionDays,
    rateLimitPruneInactiveDays: config.rateLimitPruneInactiveDays,
  });

  if (opts.dryRun) {
    const scheduler = await store.getSchedulerState();
    const pending = (scheduler?.maintenancePrunePending ?? 0) !== 0;
    const progress = parseProgress(scheduler?.maintenanceRunJson);
    const session = cumulativeFromProgress(progress);
    const done = sessionDone(session);
    opts.onProgress?.({
      phase: pending ? phaseLabel(progress) : "idle",
      pct: computeProgressPct(done, estimate.total),
      etaSec: null,
      done,
      total: estimate.total,
      estimate,
      session,
    });
    return {
      ok: true,
      aborted: false,
      complete: estimate.total === 0 && !pending,
      iterations: 0,
      session,
      lastPhase: progress?.phase,
    };
  }

  const schedulerAtStart = await store.getSchedulerState();
  const progressAtStart = parseProgress(schedulerAtStart?.maintenanceRunJson);
  const sessionAtStart = cumulativeFromProgress(progressAtStart);
  const doneAtStart = sessionDone(sessionAtStart);
  const loopStartedAt = Date.now();
  let lastProgressAt = loopStartedAt;
  let lastDone = doneAtStart;

  const session: MaintenanceCliProgress["session"] = {
    backfillUpdated: 0,
    jobsDeleted: 0,
    rateLimitsDeleted: 0,
    syncStateOrphansDeleted: 0,
  };

  let iterations = 0;
  let aborted = false;
  let lastPhase: MaintenancePhase | "complete" | undefined;
  let complete = false;

  const onAbort = () => {
    aborted = true;
  };
  if (opts.signal) {
    if (opts.signal.aborted) aborted = true;
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const emitProgress = async (phase: MaintenanceCliProgress["phase"]) => {
    const scheduler = await store.getSchedulerState();
    const progress = parseProgress(scheduler?.maintenanceRunJson);
    const cumulative = cumulativeFromProgress(progress);
    const done = sessionDone(cumulative);
    const now = Date.now();
    if (now - lastProgressAt >= ETA_WINDOW_MS && done > lastDone) {
      lastProgressAt = now;
      lastDone = done;
    }
    const etaSec = estimateEta(loopStartedAt, doneAtStart, done, estimate.total);
    opts.onProgress?.({
      phase,
      pct: computeProgressPct(done, estimate.total),
      etaSec,
      done,
      total: estimate.total,
      estimate,
      session: cumulative,
    });
  };

  while (!aborted) {
    const result = await runScheduledMaintenance(
      store,
      config,
      budget,
      forceDueCounter,
      { skipNonCritical: false, deadlineMs: Date.now() + tickMs },
    );

    session.backfillUpdated += result.backfillUpdated;
    session.jobsDeleted += result.jobsDeleted;
    session.rateLimitsDeleted += result.rateLimitsDeleted;
    session.syncStateOrphansDeleted += result.syncStateOrphansDeleted;
    iterations++;

    const scheduler = await store.getSchedulerState();
    const progress = parseProgress(scheduler?.maintenanceRunJson);
    lastPhase = result.prunePending ? progress?.phase : "complete";

    const nullBackfill = await store.countDoneJobsWithNullCompletedAt();
    complete = !result.prunePending && nullBackfill === 0;

    await emitProgress(complete ? "complete" : (progress?.phase ?? "idle"));

    if (complete) break;
    if (aborted) break;

    if (
      result.backfillUpdated === 0 &&
      result.jobsDeleted === 0 &&
      result.rateLimitsDeleted === 0 &&
      result.syncStateOrphansDeleted === 0 &&
      result.prunePending
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (aborted) {
    await emitProgress(lastPhase ?? "idle");
  }

  return {
    ok: true,
    aborted,
    complete,
    iterations,
    session,
    lastPhase,
  };
}
