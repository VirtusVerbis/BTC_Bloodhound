import type { JobType } from "../config.js";

export type JobClass = "ingest" | "maint" | "cosmetic";

const INGEST_TYPES = new Set<JobType>([
  "backfill_hacker_address",
  "audit_hacker_backfill",
  "expand_downstream",
]);

const MAINT_TYPES = new Set<JobType>([
  "poll_hacker_address",
  "poll_downstream_address",
  "sync_coldcardwatch",
  "sync_vercel_trackers",
  "process_tx",
]);

const COSMETIC_TYPES = new Set<JobType>([
  "refresh_live_balance",
  "refresh_btc_usd_price",
  "backfill_op_return",
]);

export const INGEST_JOB_TYPES = [...INGEST_TYPES] as JobType[];

export const MAINT_COSMETIC_JOB_TYPES = [...MAINT_TYPES, ...COSMETIC_TYPES] as JobType[];

export function jobClassForType(type: string): JobClass {
  if (INGEST_TYPES.has(type as JobType)) return "ingest";
  if (COSMETIC_TYPES.has(type as JobType)) return "cosmetic";
  return "maint";
}

export function isIngestJobType(type: string): boolean {
  return INGEST_TYPES.has(type as JobType);
}

export function isMaintCosmeticJobType(type: string): boolean {
  return MAINT_TYPES.has(type as JobType) || COSMETIC_TYPES.has(type as JobType);
}

export function isAgeBoostEligible(type: string): boolean {
  return isMaintCosmeticJobType(type);
}

/** True when a backfill/expand job payload has saved cursor or unfinished page work. */
export function isIngestContinuation(payloadJson: string): boolean {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return false;
  }

  if (payload.chainCursor != null && payload.chainCursor !== "") return true;

  const pending = payload.pendingTxids;
  if (Array.isArray(pending) && pending.length > 0) return true;

  const pendingTxs = payload.pendingTxs;
  if (Array.isArray(pendingTxs) && pendingTxs.length > 0) return true;

  const processedIndex = payload.processedIndex;
  if (typeof processedIndex === "number" && processedIndex > 0) return true;

  if (payload.pagesExhausted === false) {
    const pagesFetched = payload.pagesFetched;
    if (typeof pagesFetched === "number" && pagesFetched > 0) return true;
    if (payload.chainCursor != null) return true;
  }

  if (payload.traceEdgesPending === true) return true;
  const traceEdgeIndex = payload.traceEdgeIndex;
  if (typeof traceEdgeIndex === "number" && traceEdgeIndex > 0) return true;

  return false;
}
