import type { AppConfig } from "../config.js";

export interface DrainBeforeScheduleInput {
  continuationPending: boolean;
  queueDepth: number;
  queueDrainFirstDepth: number;
}

/** Whether to process jobs before the schedule phase this tick. */
export function shouldDrainBeforeSchedule(input: DrainBeforeScheduleInput): boolean {
  if (input.continuationPending) return true;
  return input.queueDepth >= input.queueDrainFirstDepth;
}

/** Dynamic jobs-per-tick cap based on queue depth (bounded by jobsPerTickMax). */
export function effectiveJobsPerTick(config: AppConfig, queueDepth: number): number {
  const base = config.jobsPerTick;
  const max = Math.max(base, config.jobsPerTickMax);
  const step = Math.max(1, config.queueDepthPerExtraJob);
  const extra = Math.floor(Math.max(0, queueDepth - 1) / step);
  return Math.min(max, base + extra);
}
