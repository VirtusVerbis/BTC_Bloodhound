export type QuotaUsageSnapshot = {
  quotaDayUtc: string;
  rowsReadTotal: number;
  rowsWrittenTotal: number;
  workersRequestsTotal: number;
  rowsReadCron: number;
  rowsWrittenCron: number;
  workersRequestsCron: number;
};

export type DailyQuotaLimits = {
  rowsReadLimit: number;
  rowsWrittenLimit: number;
  workersRequestsLimit: number;
};

export type CronPaceOptions = {
  cronUtilizationPct: number;
  /** Fraction of daily limit withheld from resume threshold (default 0.01 = 1%). */
  hysteresisPct?: number;
  now?: Date;
};

export type CronPaceReason =
  | "account_reads"
  | "account_writes"
  | "account_requests"
  | "cron_reads"
  | "cron_writes"
  | "cron_requests";

export type CronPaceResult = {
  paced: boolean;
  reason: CronPaceReason | null;
  dayProgress: number;
  totalAllowance: { reads: number; writes: number; requests: number };
  cronAllowance: { reads: number; writes: number; requests: number };
};

const MS_PER_UTC_DAY = 86_400_000;

/** Fraction of the UTC day elapsed (0 at midnight, 1 just before next midnight). */
export function computeUtcDayProgress(now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsed = now.getTime() - start;
  return Math.min(1, Math.max(0, elapsed / MS_PER_UTC_DAY));
}

export function todayUtcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Linear allowance for a daily limit at the current wall-clock progress. */
export function computeLinearAllowance(limit: number, dayProgress: number): number {
  if (limit <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(limit * dayProgress);
}

function cronUtilFraction(cronUtilizationPct: number): number {
  const pct = Number.isFinite(cronUtilizationPct) ? cronUtilizationPct : 100;
  return Math.min(1, Math.max(0, pct / 100));
}

function hysteresisAmount(limit: number, hysteresisPct: number): number {
  if (limit <= 0) return 0;
  const pct = Number.isFinite(hysteresisPct) ? hysteresisPct : 0.01;
  return Math.max(1, Math.floor(limit * Math.min(0.1, Math.max(0, pct))));
}

function isAheadOfAllowance(used: number, allowance: number, limit: number, hysteresisPct: number): boolean {
  if (!Number.isFinite(allowance)) return false;
  return used >= allowance + hysteresisAmount(limit, hysteresisPct);
}

/**
 * Returns true when cron should skip a tick to preserve API headroom.
 * Paced when account-wide OR cron-only usage exceeds linear wall-clock budget.
 */
export function shouldPaceCron(
  snapshot: QuotaUsageSnapshot,
  limits: DailyQuotaLimits,
  opts: CronPaceOptions,
): CronPaceResult {
  const now = opts.now ?? new Date();
  const dayProgress = computeUtcDayProgress(now);
  const hysteresisPct = opts.hysteresisPct ?? 0.01;
  const cronFrac = cronUtilFraction(opts.cronUtilizationPct);

  const totalAllowance = {
    reads: computeLinearAllowance(limits.rowsReadLimit, dayProgress),
    writes: computeLinearAllowance(limits.rowsWrittenLimit, dayProgress),
    requests: computeLinearAllowance(limits.workersRequestsLimit, dayProgress),
  };
  const cronAllowance = {
    reads: computeLinearAllowance(limits.rowsReadLimit * cronFrac, dayProgress),
    writes: computeLinearAllowance(limits.rowsWrittenLimit * cronFrac, dayProgress),
    requests: computeLinearAllowance(limits.workersRequestsLimit * cronFrac, dayProgress),
  };

  const checks: Array<{ paced: boolean; reason: CronPaceReason }> = [
    {
      paced: isAheadOfAllowance(
        snapshot.rowsReadTotal,
        totalAllowance.reads,
        limits.rowsReadLimit,
        hysteresisPct,
      ),
      reason: "account_reads",
    },
    {
      paced: isAheadOfAllowance(
        snapshot.rowsWrittenTotal,
        totalAllowance.writes,
        limits.rowsWrittenLimit,
        hysteresisPct,
      ),
      reason: "account_writes",
    },
    {
      paced: isAheadOfAllowance(
        snapshot.workersRequestsTotal,
        totalAllowance.requests,
        limits.workersRequestsLimit,
        hysteresisPct,
      ),
      reason: "account_requests",
    },
    {
      paced: isAheadOfAllowance(
        snapshot.rowsReadCron,
        cronAllowance.reads,
        limits.rowsReadLimit * cronFrac,
        hysteresisPct,
      ),
      reason: "cron_reads",
    },
    {
      paced: isAheadOfAllowance(
        snapshot.rowsWrittenCron,
        cronAllowance.writes,
        limits.rowsWrittenLimit * cronFrac,
        hysteresisPct,
      ),
      reason: "cron_writes",
    },
    {
      paced: isAheadOfAllowance(
        snapshot.workersRequestsCron,
        cronAllowance.requests,
        limits.workersRequestsLimit * cronFrac,
        hysteresisPct,
      ),
      reason: "cron_requests",
    },
  ];

  const hit = checks.find((c) => c.paced);
  return {
    paced: hit != null,
    reason: hit?.reason ?? null,
    dayProgress,
    totalAllowance,
    cronAllowance,
  };
}

/** Compact count for logs and UI (e.g. 4200000 → "4.2M"). */
export function formatQuotaCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (v >= 10_000) {
    const k = v / 1_000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return v.toLocaleString("en-US");
}

export function formatQuotaUsageLine(
  snapshot: Pick<QuotaUsageSnapshot, "rowsReadTotal" | "rowsWrittenTotal" | "workersRequestsTotal">,
  limits: DailyQuotaLimits,
): string {
  return (
    `D1 reads: ${formatQuotaCount(snapshot.rowsReadTotal)}/${formatQuotaCount(limits.rowsReadLimit)} · ` +
    `D1 writes: ${formatQuotaCount(snapshot.rowsWrittenTotal)}/${formatQuotaCount(limits.rowsWrittenLimit)} · ` +
    `Requests: ${formatQuotaCount(snapshot.workersRequestsTotal)}/${formatQuotaCount(limits.workersRequestsLimit)}`
  );
}

export function formatCronPaceSkipLine(
  result: CronPaceResult,
  snapshot: QuotaUsageSnapshot,
  resetIn: string,
): string {
  const reason = result.reason ?? "unknown";
  const used =
    reason === "account_reads" || reason === "cron_reads"
      ? snapshot.rowsReadTotal
      : reason === "account_writes" || reason === "cron_writes"
        ? snapshot.rowsWrittenTotal
        : snapshot.workersRequestsTotal;
  const allowance =
    reason.startsWith("cron_")
      ? reason === "cron_reads"
        ? result.cronAllowance.reads
        : reason === "cron_writes"
          ? result.cronAllowance.writes
          : result.cronAllowance.requests
      : reason === "account_reads"
        ? result.totalAllowance.reads
        : reason === "account_writes"
          ? result.totalAllowance.writes
          : result.totalAllowance.requests;
  return (
    `[cron] tick skipped quota_pace reason=${reason} total=${used} allowance=${allowance} ` +
    `cronSlice=${result.cronAllowance.reads} resetIn=${resetIn}`
  );
}

/** Next 00:00 UTC as ISO string (when D1 free-tier daily limits reset). */
export function nextUtcMidnightIso(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function formatUtcResetCountdown(now = Date.now()): string {
  const resetAt = new Date(nextUtcMidnightIso(new Date(now))).getTime();
  const sec = Math.max(0, Math.ceil((resetAt - now) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m${remSec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}
