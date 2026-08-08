import type { Job } from "@cointrace/db";
import type { Store } from "@cointrace/db";

export async function computeJobEta(
  store: Store,
  job: Job,
  rateLimitMs: number,
  jobsPerTick: number,
): Promise<{ queuePosition: number; estimatedSeconds: number; estimatedRunAt: string }> {
  const queuePosition = await store.countPendingJobsBefore(job.priority, job.runAfter);
  const tickMs = rateLimitMs / jobsPerTick;
  const estimatedSeconds = Math.ceil((queuePosition + 1) * (tickMs / 1000));
  const scheduler = await store.getSchedulerState();
  const nextProvider = scheduler?.nextProviderCallAt ? new Date(scheduler.nextProviderCallAt).getTime() : Date.now();
  const runAfter = new Date(job.runAfter).getTime();
  const estimatedRunAt = new Date(Math.max(nextProvider, runAfter) + queuePosition * tickMs).toISOString();
  return { queuePosition, estimatedSeconds, estimatedRunAt };
}
