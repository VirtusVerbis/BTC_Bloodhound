import type { MaintenanceRunProgress, Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import type { SubrequestBudget } from "./subrequestBudget.js";

export interface ScheduledMaintenanceOpts {
  deadlineMs?: number;
  skipNonCritical: boolean;
}

export interface ScheduledMaintenanceResult {
  backfillUpdated: number;
  seedCache: boolean;
  jobsDeleted: number;
  rateLimitsDeleted: number;
  syncStateOrphansDeleted: number;
  batchesTotal: number;
  prunePending: boolean;
}

function mergeProgress(
  base: MaintenanceRunProgress,
  patch: Partial<MaintenanceRunProgress>,
): MaintenanceRunProgress {
  return {
    ...base,
    ...patch,
    jobsDeleted: (base.jobsDeleted ?? 0) + (patch.jobsDeleted ?? 0),
    rateLimitsDeleted: (base.rateLimitsDeleted ?? 0) + (patch.rateLimitsDeleted ?? 0),
    syncStateOrphansDeleted:
      (base.syncStateOrphansDeleted ?? 0) + (patch.syncStateOrphansDeleted ?? 0),
    completedAtBackfillUpdated:
      (base.completedAtBackfillUpdated ?? 0) + (patch.completedAtBackfillUpdated ?? 0),
  };
}

function parseProgress(raw: string | null | undefined): MaintenanceRunProgress | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MaintenanceRunProgress;
  } catch {
    return null;
  }
}

export async function runScheduledMaintenance(
  store: Store,
  config: AppConfig,
  _budget: SubrequestBudget,
  maintenanceCronCounter: number,
  opts: ScheduledMaintenanceOpts,
): Promise<ScheduledMaintenanceResult> {
  const result: ScheduledMaintenanceResult = {
    backfillUpdated: 0,
    seedCache: false,
    jobsDeleted: 0,
    rateLimitsDeleted: 0,
    syncStateOrphansDeleted: 0,
    batchesTotal: 0,
    prunePending: false,
  };

  if (opts.skipNonCritical || (await store.isD1QuotaBlocked("write"))) {
    return result;
  }

  let batchesLeft = config.maintenanceMaxBatchesPerTick;
  let writesLeft = config.maintenanceMaxWritesPerTick;
  const deadlineMs = opts.deadlineMs;
  const batchOpts = () => ({
    deadlineMs,
    remainingBatches: batchesLeft,
    remainingWrites: writesLeft,
  });

  const state = await store.getSchedulerState();
  const prunePending = (state?.maintenancePrunePending ?? 0) !== 0;
  let progress: MaintenanceRunProgress = prunePending
    ? (parseProgress(state?.maintenanceRunJson) ?? { startedAt: new Date().toISOString() })
    : { startedAt: new Date().toISOString() };

  const backfill = await store.backfillDoneJobCompletedAt({
    ...batchOpts(),
    batchSize: config.jobCompletedAtBackfillBatchSize,
    maxBatchesPerRun: config.jobCompletedAtBackfillMaxBatchesPerTick,
  });
  result.backfillUpdated = backfill.affected;
  result.batchesTotal += backfill.batches;
  batchesLeft -= backfill.batches;
  writesLeft -= backfill.affected;
  if (backfill.affected > 0) {
    progress = mergeProgress(progress, {
      phase: "backfill_completed_at",
      completedAtBackfillUpdated: backfill.affected,
    });
  }

  result.seedCache = await store.seedLastCompletedJobCache();

  if (maintenanceCronCounter % 1440 === 0) {
    await store.reconcileStatsCounters();
  } else if (maintenanceCronCounter % 60 === 0) {
    await store.reconcileCheapCounters();
  }

  const pruneDueTick =
    config.jobPruneIntervalDays > 0 &&
    maintenanceCronCounter % (config.jobPruneIntervalDays * 1440) === 0;
  const nullCompletedAt = await store.countDoneJobsWithNullCompletedAt();
  const shouldPrune =
    config.jobPruneEnabled && nullCompletedAt === 0 && (prunePending || pruneDueTick);

  if (!shouldPrune) {
    if (prunePending && nullCompletedAt > 0) {
      await store.updateSchedulerState({
        maintenancePrunePending: 1,
        maintenanceRunJson: JSON.stringify(
          mergeProgress(progress, { phase: "backfill_completed_at" }),
        ),
      });
      result.prunePending = true;
    }
    return result;
  }

  let housekeepingComplete = true;

  progress = mergeProgress(progress, {
    phase: "prune_done_jobs",
    startedAt: progress.startedAt ?? new Date().toISOString(),
  });
  await store.updateSchedulerState({
    maintenancePrunePending: 1,
    maintenanceRunJson: JSON.stringify(progress),
  });

  const prune = await store.pruneDoneJobs({
    ...batchOpts(),
    batchSize: config.jobPruneBatchSize,
    maxBatchesPerRun: Math.min(config.jobPruneMaxBatchesPerRun, batchesLeft),
    maxPerRun: Math.min(config.jobPruneMaxDeletesPerRun, writesLeft),
    retentionDays: config.jobDoneRetentionDays,
  });
  result.jobsDeleted = prune.affected;
  result.batchesTotal += prune.batches;
  batchesLeft -= prune.batches;
  writesLeft -= prune.affected;
  progress = mergeProgress(progress, { phase: "prune_done_jobs", jobsDeleted: prune.affected });
  housekeepingComplete = prune.complete;

  if (housekeepingComplete && batchesLeft > 0 && writesLeft > 0) {
    progress = mergeProgress(progress, { phase: "rate_limits" });
    const rateLimits = await store.pruneStaleRateLimits({
      ...batchOpts(),
      batchSize: config.rateLimitPruneBatchSize,
      maxBatchesPerRun: Math.min(config.rateLimitPruneMaxBatchesPerRun, batchesLeft),
      maxPerRun: writesLeft,
      inactiveSec: config.rateLimitPruneInactiveDays * 24 * 60 * 60,
    });
    result.rateLimitsDeleted = rateLimits.affected;
    result.batchesTotal += rateLimits.batches;
    batchesLeft -= rateLimits.batches;
    writesLeft -= rateLimits.affected;
    progress = mergeProgress(progress, {
      phase: "rate_limits",
      rateLimitsDeleted: rateLimits.affected,
    });
    housekeepingComplete = rateLimits.complete;
  }

  if (housekeepingComplete && batchesLeft > 0 && writesLeft > 0) {
    progress = mergeProgress(progress, { phase: "sync_state_orphans" });
    const syncOrphans = await store.pruneOrphanSyncState({
      ...batchOpts(),
      batchSize: config.syncStateOrphanPruneBatchSize,
      maxBatchesPerRun: Math.min(config.syncStateOrphanPruneMaxBatchesPerRun, batchesLeft),
      maxPerRun: writesLeft,
    });
    result.syncStateOrphansDeleted = syncOrphans.affected;
    result.batchesTotal += syncOrphans.batches;
    batchesLeft -= syncOrphans.batches;
    writesLeft -= syncOrphans.affected;
    progress = mergeProgress(progress, {
      phase: "sync_state_orphans",
      syncStateOrphansDeleted: syncOrphans.affected,
    });
    housekeepingComplete = syncOrphans.complete;
  }

  result.prunePending = !housekeepingComplete;
  const ts = new Date().toISOString();
  if (housekeepingComplete) {
    await store.updateSchedulerState({
      maintenancePrunePending: 0,
      maintenanceRunJson: null,
      lastDoneJobsPrunedAt:
        result.jobsDeleted > 0 ? ts : (state?.lastDoneJobsPrunedAt ?? undefined),
      lastHousekeepingAt:
        result.rateLimitsDeleted > 0 || result.syncStateOrphansDeleted > 0
          ? ts
          : (state?.lastHousekeepingAt ?? undefined),
    });
  } else {
    await store.updateSchedulerState({
      maintenancePrunePending: 1,
      maintenanceRunJson: JSON.stringify(progress),
    });
  }

  return result;
}

export function formatMaintenanceLogLine(result: ScheduledMaintenanceResult): string {
  return `[cron] maintenance backfill_completed_at=${result.backfillUpdated} seed_cache=${result.seedCache ? 1 : 0} jobs_deleted=${result.jobsDeleted} rate_limits_deleted=${result.rateLimitsDeleted} sync_state_orphans_deleted=${result.syncStateOrphansDeleted} batches_total=${result.batchesTotal} pending=${result.prunePending ? 1 : 0}`;
}
