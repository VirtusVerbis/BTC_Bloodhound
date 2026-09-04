import type { Job } from "@cointrace/db";
import type { ClaimAgeBoost } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { isAgeBoostEligible, MAINT_COSMETIC_JOB_TYPES } from "./jobClass.js";

export { MAINT_COSMETIC_JOB_TYPES };

export function jobRunnableAtMs(job: Job): number {
  const created = new Date(job.createdAt).getTime();
  const runAfter = new Date(job.runAfter).getTime();
  const createdMs = Number.isFinite(created) ? created : 0;
  const runAfterMs = Number.isFinite(runAfter) ? runAfter : 0;
  return Math.max(createdMs, runAfterMs);
}

export function jobWaitMs(job: Job, nowMs = Date.now()): number {
  const runnableAt = jobRunnableAtMs(job);
  if (runnableAt <= 0) return 0;
  return Math.max(0, nowMs - runnableAt);
}

export function ageBoostForJob(job: Job, config: AppConfig, nowMs = Date.now()): number {
  if (!config.ageBoostEnabled || !isAgeBoostEligible(job.type)) return 0;
  const intervalMs = config.ageBoostIntervalSec * 1000;
  if (intervalMs <= 0) return 0;
  const waitMs = jobWaitMs(job, nowMs);
  return Math.min(config.ageBoostMax, Math.floor(waitMs / intervalMs));
}

export function effectiveJobPriority(job: Job, config: AppConfig, nowMs = Date.now()): number {
  return job.priority + ageBoostForJob(job, config, nowMs);
}

export function toClaimAgeBoost(config: AppConfig): ClaimAgeBoost {
  return {
    enabled: config.ageBoostEnabled,
    intervalSec: config.ageBoostIntervalSec,
    maxBoost: config.ageBoostMax,
    eligibleTypes: MAINT_COSMETIC_JOB_TYPES,
  };
}
