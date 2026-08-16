import type { Job } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import {
  estimateJobSubreq,
  jobNeedsChainCallAtStart,
  jobWeightTier,
  parseJobPayload,
  pickIngestCandidate,
  type JobWeightTier,
} from "./jobWeight.js";

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

export type TickJobsCapReason = "heavy_head" | "pair_light" | "no_pair";

export interface TickJobsPlan {
  jobsCap: number;
  reason: TickJobsCapReason;
  headWeight: JobWeightTier | null;
  pairableCount: number;
}

function countPairableLightCandidates(
  candidates: Job[],
  config: AppConfig,
  maxEstimatedSubreq?: number,
): number {
  return candidates.filter((j) => {
    const payload = parseJobPayload(j.payloadJson);
    if (jobWeightTier(j.type, payload, config) !== "light") return false;
    if (jobNeedsChainCallAtStart(j.type, payload, config)) return false;
    if (maxEstimatedSubreq != null && estimateJobSubreq(j.type, payload, config) > maxEstimatedSubreq) {
      return false;
    }
    return true;
  }).length;
}

/** Weight-aware jobs-per-tick cap for queue drain efficiency. */
export function planTickJobs(
  config: AppConfig,
  queueDepth: number,
  candidates: Job[],
  budget?: { remaining(): number; limit(): number },
): TickJobsPlan {
  const configuredMax = effectiveJobsPerTick(config, queueDepth);
  const maxEstimatedSubreq =
    budget && budget.limit() > 0
      ? budget.remaining() - config.scheduleSubrequestReserve - 2
      : undefined;

  const head = pickIngestCandidate(candidates, config, { preferContinuation: true });
  if (!head) {
    return {
      jobsCap: configuredMax,
      reason: "no_pair",
      headWeight: null,
      pairableCount: countPairableLightCandidates(candidates, config, maxEstimatedSubreq),
    };
  }

  const headPayload = parseJobPayload(head.payloadJson);
  const headWeight = jobWeightTier(head.type, headPayload, config);
  const pairableCount = countPairableLightCandidates(candidates, config, maxEstimatedSubreq);

  if (headWeight === "heavy") {
    return { jobsCap: 1, reason: "heavy_head", headWeight, pairableCount };
  }

  if (configuredMax > 1 && pairableCount >= 2) {
    return {
      jobsCap: Math.min(2, configuredMax),
      reason: "pair_light",
      headWeight,
      pairableCount,
    };
  }

  return { jobsCap: 1, reason: "no_pair", headWeight, pairableCount };
}
