import type { Job } from "@cointrace/db";
import { D1QuotaExceededError } from "@cointrace/db";
import { RateLimitNotReadyError } from "../chain/router.js";
import { summarizeJobPayload } from "../ops/queue.js";
import { formatErrorMessage } from "../util/error.js";
import { colorizeIndexerLogLine, type IndexerLogColorMode } from "./logColor.js";
import { isIngestJobType } from "./jobClass.js";
import type { JobWeightTier, JobWorkPhase } from "./jobWeight.js";
import { formatJobRunStatsSuffix, type JobRunStats } from "./tickStats.js";

export interface JobClaimMeta {
  slot?: number;
  weight?: JobWeightTier;
  phase?: JobWorkPhase;
}

export interface JobLogOpts {
  color?: boolean;
  colorMode?: IndexerLogColorMode;
  claimMeta?: JobClaimMeta;
}

let activeLogColorMode: IndexerLogColorMode = "default";

export function setIndexerLogColorMode(mode: IndexerLogColorMode): void {
  activeLogColorMode = mode;
}

export function getIndexerLogColorMode(): IndexerLogColorMode {
  return activeLogColorMode;
}

function parsePayload(job: Job): Record<string, unknown> {
  try {
    return JSON.parse(job.payloadJson) as Record<string, unknown>;
  } catch {
    return { raw: job.payloadJson };
  }
}

function abbreviateCursor(cursor: unknown): string | null {
  if (typeof cursor !== "string" || cursor === "") return null;
  if (cursor.length <= 12) return cursor;
  return `${cursor.slice(0, 12)}…`;
}

function formatDetailSuffix(details: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof details.address === "string") parts.push(`address=${details.address}`);
  if (typeof details.txid === "string") parts.push(`txid=${details.txid}`);
  if (details.continuation === true) parts.push("continuation=true");
  if (details.cron === true) parts.push("cron=true");
  if (typeof details.pendingTxidsCount === "number") {
    parts.push(`pendingTxidsCount=${details.pendingTxidsCount}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function formatProgressSuffix(details: Record<string, unknown>): string {
  const parts: string[] = [];
  const pendingCount =
    typeof details.pendingTxidsCount === "number" ? details.pendingTxidsCount : 0;
  const processedIndex =
    typeof details.processedIndex === "number" ? details.processedIndex : null;
  if ("processedIndex" in details) {
    parts.push(`processedIndex=${details.processedIndex ?? 0}`);
  }
  if (pendingCount > 0 && processedIndex != null) {
    parts.push(`progress=${processedIndex}/${pendingCount}`);
  }
  const cursor = abbreviateCursor(details.chainCursor);
  if (cursor != null) parts.push(`chainCursor=${cursor}`);
  if (details.pagesExhausted != null) parts.push(`pagesExhausted=${details.pagesExhausted}`);
  if (details.pagesExhausted === false && typeof details.pagesFetched === "number") {
    parts.push(`pagesFetched=${details.pagesFetched}`);
  }
  if (details.traceEdgesPending === true) parts.push("traceEdgesPending=true");
  if (typeof details.traceEdgeIndex === "number") {
    parts.push(`traceEdgeIndex=${details.traceEdgeIndex}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function jobTypeShowsProgress(type: string): boolean {
  return (
    isIngestJobType(type) ||
    type === "poll_hacker_address" ||
    type === "poll_downstream_address"
  );
}

function emitLog(fn: (message: string) => void, message: string, color = false, colorMode?: IndexerLogColorMode): void {
  fn(colorizeIndexerLogLine(message, color, colorMode ?? activeLogColorMode));
}

function formatClaimMetaSuffix(meta?: JobClaimMeta): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.slot != null) parts.push(`slot=${meta.slot}`);
  if (meta.weight != null) parts.push(`weight=${meta.weight}`);
  if (meta.phase != null) parts.push(`phase=${meta.phase}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function formatJobStartLine(job: Job, claimMeta?: JobClaimMeta): string {
  const payload = parsePayload(job);
  const details = summarizeJobPayload(job.type, payload);
  return `[job] start id=${job.id} type=${job.type} attempts=${job.attempts}${formatClaimMetaSuffix(claimMeta)}${formatDetailSuffix(details)}${formatProgressSuffix(details)}`;
}

export function formatJobDoneLine(
  job: Job,
  duration: string,
  queueDepth: number,
  runStats?: JobRunStats,
  workSubreq?: number,
): string {
  const progressSuffix = jobTypeShowsProgress(job.type)
    ? formatProgressSuffix(summarizeJobPayload(job.type, parsePayload(job)))
    : "";
  return `[job] done id=${job.id} type=${job.type} duration=${duration} queue=${queueDepth}${formatJobRunStatsSuffix(runStats, workSubreq)}${progressSuffix}`;
}

export function logJobStart(job: Job, opts?: JobLogOpts): void {
  emitLog(console.log, formatJobStartLine(job, opts?.claimMeta), opts?.color ?? false, opts?.colorMode);
}

export function logJobDone(
  job: Job,
  duration: string,
  queueDepth: number,
  opts?: JobLogOpts & { runStats?: JobRunStats; workSubreq?: number },
): void {
  emitLog(
    console.log,
    formatJobDoneLine(job, duration, queueDepth, opts?.runStats, opts?.workSubreq),
    opts?.color ?? false,
    opts?.colorMode,
  );
}

export function logCronDetail(
  enabled: boolean,
  message: string,
  color = false,
  colorMode?: IndexerLogColorMode,
): void {
  if (!enabled) return;
  emitLog(console.log, message, color, colorMode);
}

export function logCronError(message: string, color = false, colorMode?: IndexerLogColorMode): void {
  emitLog(console.error, message, color, colorMode);
}

export function logJobFail(
  job: Job,
  err: unknown,
  opts?: { attempt?: number; color?: boolean; colorMode?: IndexerLogColorMode },
): void {
  const payload = parsePayload(job);
  const details = summarizeJobPayload(job.type, payload);
  const message = formatErrorMessage(err);
  const attempt = opts?.attempt ?? job.attempts + 1;
  const reasonSuffix =
    err instanceof RateLimitNotReadyError
      ? ` reason=${err.reason}`
      : err instanceof D1QuotaExceededError
        ? ` reason=d1-quota kind=${err.kind}`
        : "";
  emitLog(
    console.error,
    `[job] fail id=${job.id} type=${job.type} attempts=${attempt}${formatDetailSuffix(details)}${reasonSuffix} error=${message}`,
    opts?.color ?? false,
    opts?.colorMode,
  );
}

export function logJobDefer(
  job: Job,
  opts: { attempt: number; deferSec: number; runAfter: string; color?: boolean; colorMode?: IndexerLogColorMode },
): void {
  const payload = parsePayload(job);
  const details = summarizeJobPayload(job.type, payload);
  emitLog(
    console.warn,
    `[job] defer id=${job.id} type=${job.type} attempts=${opts.attempt} deferSec=${opts.deferSec} run_after=${opts.runAfter}${formatDetailSuffix(details)}`,
    opts.color ?? false,
    opts.colorMode,
  );
}
