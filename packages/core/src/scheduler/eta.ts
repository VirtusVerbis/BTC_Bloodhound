import type { ClaimAgeBoost, Job } from "@cointrace/db";
import type { Store } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { ageBoostForJob, effectiveJobPriority, jobWaitMs, toClaimAgeBoost } from "../indexer/jobAge.js";

export async function computeJobEta(
  store: Store,
  job: Job,
  rateLimitMs: number,
  jobsPerTick: number,
  config?: AppConfig,
): Promise<{ queuePosition: number; estimatedSeconds: number; estimatedRunAt: string }> {
  const ageBoost: ClaimAgeBoost | undefined = config ? toClaimAgeBoost(config) : undefined;
  const queuePosition = ageBoost?.enabled
    ? await store.countPendingJobsBeforeEffective(
        job.priority,
        job.runAfter,
        job.createdAt,
        job.type,
        ageBoost,
      )
    : await store.countPendingJobsBefore(job.priority, job.runAfter, job.createdAt);
  const tickMs = rateLimitMs / jobsPerTick;
  const estimatedSeconds = Math.ceil((queuePosition + 1) * (tickMs / 1000));
  const scheduler = await store.getSchedulerState();
  const nextProvider = scheduler?.nextProviderCallAt ? new Date(scheduler.nextProviderCallAt).getTime() : Date.now();
  const runAfter = new Date(job.runAfter).getTime();
  const estimatedRunAt = new Date(Math.max(nextProvider, runAfter) + queuePosition * tickMs).toISOString();
  return { queuePosition, estimatedSeconds, estimatedRunAt };
}

export function jobEtaFields(job: Job, config?: AppConfig, nowMs = Date.now()) {
  if (!config) {
    return { waitSec: Math.floor(jobWaitMs(job, nowMs) / 1000), ageBoost: 0, effectivePriority: job.priority };
  }
  const boost = ageBoostForJob(job, config, nowMs);
  return {
    waitSec: Math.floor(jobWaitMs(job, nowMs) / 1000),
    ageBoost: boost,
    effectivePriority: effectiveJobPriority(job, config, nowMs),
  };
}
