import type { Job } from "@cointrace/db";
import type { AppConfig } from "../config.js";
import { isIngestContinuation, isIngestJobType } from "./jobClass.js";
import { parsePendingTxs } from "./txPage.js";

export type JobWeightTier = "heavy" | "light";
export type JobWorkPhase = "process" | "fetch" | "poll" | "audit" | "sync" | "other";

export function parseJobPayload(payloadJson: string): Record<string, unknown> {
  try {
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function pendingLength(payload: Record<string, unknown>): number {
  return parsePendingTxs(payload).length;
}

export function jobNeedsChainCallAtStart(
  type: string,
  payload: Record<string, unknown>,
  config?: AppConfig,
): boolean {
  if (type === "poll_hacker_address" || type === "poll_downstream_address") return true;
  if (type === "audit_hacker_backfill") return true;
  if (type === "refresh_live_balance" || type === "refresh_btc_usd_price") return true;

  if (!isIngestJobType(type)) {
    if (type === "sync_coldcardwatch" || type === "sync_vercel_trackers") return false;
    if (type === "process_tx") return false;
    return false;
  }

  const processedIndex = typeof payload.processedIndex === "number" ? payload.processedIndex : 0;
  const pendingLen = pendingLength(payload);
  if (processedIndex < pendingLen) return false;

  const pagesExhausted = payload.pagesExhausted === true;
  if (pagesExhausted) return false;

  if (type === "expand_downstream" && config) {
    const pagesFetched = typeof payload.pagesFetched === "number" ? payload.pagesFetched : 0;
    const maxPages = Math.max(1, Math.ceil(config.backfillMaxTxs / 25));
    if (pagesFetched >= maxPages) return false;
  }

  return true;
}

export function estimateJobSubreq(type: string, payload: Record<string, unknown>, config: AppConfig): number {
  if (!jobNeedsChainCallAtStart(type, payload, config)) {
    return config.backfillTxsPerJob * 3;
  }
  return 8 + config.backfillTxsPerJob * 4;
}

function heavySubreqThreshold(config: AppConfig): number {
  if (config.maxSubrequestsPerJob > 0) return config.maxSubrequestsPerJob;
  if (config.subrequestLimitPerInvocation > 0) {
    const workBudget = config.subrequestLimitPerInvocation - config.scheduleSubrequestReserve;
    return Math.max(1, Math.floor(workBudget / 2));
  }
  return Number.POSITIVE_INFINITY;
}

export function jobWeightTier(
  type: string,
  payload: Record<string, unknown>,
  config: AppConfig,
): JobWeightTier {
  if (payload.traceEdgesPending === true) return "heavy";
  if (jobNeedsChainCallAtStart(type, payload, config)) return "heavy";
  if (estimateJobSubreq(type, payload, config) > heavySubreqThreshold(config)) return "heavy";
  return "light";
}

export function jobWorkPhase(
  type: string,
  payload: Record<string, unknown>,
  config?: AppConfig,
): JobWorkPhase {
  if (type === "poll_hacker_address" || type === "poll_downstream_address") return "poll";
  if (type === "audit_hacker_backfill") return "audit";
  if (type === "sync_coldcardwatch" || type === "sync_vercel_trackers") return "sync";
  if (isIngestJobType(type)) {
    return jobNeedsChainCallAtStart(type, payload, config) ? "fetch" : "process";
  }
  return "other";
}

export interface PickIngestCandidateOpts {
  preferContinuation?: boolean;
  requireNoChainAtStart?: boolean;
  preferProcessOnly?: boolean;
  excludeIds?: number[];
  maxEstimatedSubreq?: number;
}

export function pickIngestCandidate(
  candidates: Job[],
  config: AppConfig,
  opts?: PickIngestCandidateOpts,
): Job | null {
  const exclude = new Set(opts?.excludeIds ?? []);
  let pool = candidates.filter((j) => !exclude.has(j.id));

  if (opts?.requireNoChainAtStart) {
    pool = pool.filter((j) => {
      const payload = parseJobPayload(j.payloadJson);
      return !jobNeedsChainCallAtStart(j.type, payload, config);
    });
  }

  if (opts?.maxEstimatedSubreq != null) {
    pool = pool.filter((j) => {
      const payload = parseJobPayload(j.payloadJson);
      return estimateJobSubreq(j.type, payload, config) <= opts.maxEstimatedSubreq!;
    });
  }

  if (pool.length === 0) return null;

  if (opts?.preferProcessOnly) {
    const processOnly = pool.filter((j) => {
      const payload = parseJobPayload(j.payloadJson);
      return !jobNeedsChainCallAtStart(j.type, payload, config);
    });
    if (processOnly.length > 0) pool = processOnly;
  }

  let pick = pool[0]!;

  if (opts?.preferContinuation) {
    const cont = pool.find(
      (j) => isIngestContinuation(j.payloadJson) && (j.reclaimCount ?? 0) === 0,
    );
    if (cont) pick = cont;
  }

  if ((pick.reclaimCount ?? 0) > 0 && isIngestContinuation(pick.payloadJson)) {
    const alt = pool.find((j) => (j.reclaimCount ?? 0) === 0);
    if (alt) pick = alt;
  }

  return pick;
}

export function jobClaimMeta(
  job: Job,
  config: AppConfig,
  slot: number,
): { slot: number; weight: JobWeightTier; phase: JobWorkPhase } {
  const payload = parseJobPayload(job.payloadJson);
  return {
    slot,
    weight: jobWeightTier(job.type, payload, config),
    phase: jobWorkPhase(job.type, payload, config),
  };
}
