import type { SubrequestBudget } from "./subrequestBudget.js";

export type TickStopReason = "idle" | "deadline" | "subreq" | "jobs_cap" | "pacing" | "pair_wait";

export type BtcScheduleMode = "fresh" | "inline" | "queued" | "skip";

export interface ScheduleTickStats {
  skipNonCritical: boolean;
  crawlEnqueued: number;
  pollEnqueued: number;
  maintTick: boolean;
  btc: BtcScheduleMode;
  throttled?: boolean;
}

export interface TickDoneStats {
  processed: number;
  elapsedMs: number;
  subreqUsed: number;
  subreqLimit: number;
  schedSubreq: number;
  workSubreq: number;
  subreqRem: number;
  queue: number;
  stop: TickStopReason;
  order?: "drain" | "schedule-first";
  jobsCap?: number;
  jobsCapReason?: string;
}

export interface TickPlanStats {
  jobsCap: number;
  jobsCapReason: string;
  headWeight: string | null;
  pairable: number;
  queue: number;
}

export interface JobRunStats {
  continued?: boolean;
  traceEdgeIndex?: number;
  traceEdgeTotal?: number;
  edgesApplied?: number;
  workSubreq?: number;
  cpuGuard?: boolean;
}

function formatSubreqFields(used: number, limit: number, sched: number): string {
  if (limit <= 0) return "";
  return ` subreq=${used}/${limit} sched=${sched}`;
}

export function formatCronScheduleDoneLine(
  stats: ScheduleTickStats,
  budget: SubrequestBudget,
  schedSubreq: number,
): string {
  const used = budget.used();
  const limit = budget.limit();
  const subreqPart = formatSubreqFields(used, limit, schedSubreq);
  const throttledPart = stats.throttled === true ? " throttled=true" : "";
  return `[cron] schedule done${subreqPart}${throttledPart} skipNonCritical=${stats.skipNonCritical} crawlEnq=${stats.crawlEnqueued} pollEnq=${stats.pollEnqueued} maint=${stats.maintTick} btc=${stats.btc}`;
}

export function formatCronTickDoneLine(stats: TickDoneStats): string {
  const subreqPart =
    stats.subreqLimit > 0
      ? ` subreq=${stats.subreqUsed}/${stats.subreqLimit} sched=${stats.schedSubreq} work=${stats.workSubreq} rem=${stats.subreqRem}`
      : "";
  const orderPart = stats.order ? ` order=${stats.order}` : "";
  const jobsCapPart = stats.jobsCap != null ? ` jobsCap=${stats.jobsCap}` : "";
  const jobsCapReasonPart = stats.jobsCapReason ? ` jobsCapReason=${stats.jobsCapReason}` : "";
  return `[cron] tick done processed=${stats.processed} ms=${stats.elapsedMs}${subreqPart}${orderPart}${jobsCapPart}${jobsCapReasonPart} stop=${stats.stop} queue=${stats.queue}`;
}

export function formatTickPlanLine(stats: TickPlanStats): string {
  const headWeightPart = stats.headWeight != null ? ` headWeight=${stats.headWeight}` : "";
  return `[cron] tick plan jobsCap=${stats.jobsCap} jobsCapReason=${stats.jobsCapReason}${headWeightPart} pairable=${stats.pairable} queue=${stats.queue}`;
}

export function formatJobRunStatsSuffix(stats?: JobRunStats, workSubreq?: number): string {
  const parts: string[] = [];
  if (workSubreq != null && workSubreq > 0) parts.push(`workSubreq=${workSubreq}`);
  if (stats?.continued === true) parts.push("continued=true");
  if (stats?.continued === false) parts.push("continued=false");
  if (
    stats?.traceEdgeIndex != null &&
    stats.traceEdgeTotal != null &&
    stats.traceEdgeTotal > 0
  ) {
    parts.push(`traceEdge=${stats.traceEdgeIndex}/${stats.traceEdgeTotal}`);
  }
  if (stats?.edgesApplied != null && stats.edgesApplied > 0) {
    parts.push(`edgesApplied=${stats.edgesApplied}`);
  }
  if (stats?.cpuGuard === true) parts.push("cpuGuard=1");
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
