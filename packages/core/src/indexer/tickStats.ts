import type { SubrequestBudget } from "./subrequestBudget.js";

export type TickStopReason = "idle" | "deadline" | "subreq" | "jobs_cap";

export type BtcScheduleMode = "fresh" | "inline" | "queued" | "skip";

export interface ScheduleTickStats {
  skipNonCritical: boolean;
  crawlEnqueued: number;
  pollEnqueued: number;
  maintTick: boolean;
  btc: BtcScheduleMode;
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
}

export interface JobRunStats {
  continued?: boolean;
  traceEdgeIndex?: number;
  traceEdgeTotal?: number;
  edgesApplied?: number;
  workSubreq?: number;
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
  return `[cron] schedule done${subreqPart} skipNonCritical=${stats.skipNonCritical} crawlEnq=${stats.crawlEnqueued} pollEnq=${stats.pollEnqueued} maint=${stats.maintTick} btc=${stats.btc}`;
}

export function formatCronTickDoneLine(stats: TickDoneStats): string {
  const subreqPart =
    stats.subreqLimit > 0
      ? ` subreq=${stats.subreqUsed}/${stats.subreqLimit} sched=${stats.schedSubreq} work=${stats.workSubreq} rem=${stats.subreqRem}`
      : "";
  return `[cron] tick done processed=${stats.processed} ms=${stats.elapsedMs}${subreqPart} stop=${stats.stop} queue=${stats.queue}`;
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
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
