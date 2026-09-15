import { truncateAddress } from "./api";
import type { QueueJob, QueueJobClass } from "./queueApi";
import type { MaintenanceStatus } from "../components/MonitoringIndicator";

export function jobRunnableAtMs(job: Pick<QueueJob, "createdAt" | "runAfter">): number {
  const created = new Date(job.createdAt).getTime();
  const runAfter = new Date(job.runAfter).getTime();
  const createdMs = Number.isFinite(created) ? created : 0;
  const runAfterMs = Number.isFinite(runAfter) ? runAfter : 0;
  return Math.max(createdMs, runAfterMs);
}

/** Human-readable duration without trailing "ago" (e.g. "47m 12s", "1h 05m"). */
export function formatDurationMs(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1000) return "just now";
  const totalSec = Math.floor(elapsedMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${String(remMin).padStart(2, "0")}m`;
}

export function formatJobWaitDuration(job: QueueJob, nowMs: number): string | null {
  if (job.status !== "pending" || !job.runAfterDue) return null;
  const runnableAt = jobRunnableAtMs(job);
  if (runnableAt <= 0) return null;
  const waitMs = nowMs - runnableAt;
  if (waitMs < 1000) return null;
  return formatDurationMs(waitMs);
}

export interface JobPriorityBadge {
  label: string;
  title?: string;
  boosted: boolean;
}

export function formatJobPriorityBadge(job: QueueJob): JobPriorityBadge {
  if (job.ageBoost > 0) {
    return {
      label: `pri ${job.priority} → ${job.effectivePriority}`,
      title: `Base priority ${job.priority} · age boost +${job.ageBoost} · effective ${job.effectivePriority}`,
      boosted: true,
    };
  }
  return {
    label: `pri ${job.priority}`,
    boosted: false,
  };
}

export function formatSnapshotAge(elapsedMs: number | null | undefined): string {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs < 0) return "—";
  if (elapsedMs < 1000) return "just now";
  const totalSec = Math.floor(elapsedMs / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s ago`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${String(remMin).padStart(2, "0")}m ago`;
}

export function formatJobTypeLabel(type: string): string {
  return type
    .split("_")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function formatSyncSourceLabel(source: string): string {
  switch (source) {
    case "coldcard_hack_tracker":
      return "hack tracker";
    case "coldcard_sweep_watch":
      return "sweep watch";
    default:
      return source.replace(/_/g, " ");
  }
}

export function formatJobDetailLine(job: QueueJob): string {
  const { details, type } = job;
  const parts: string[] = [];

  if (typeof details.address === "string") {
    parts.push(truncateAddress(details.address));
  }
  if (typeof details.txid === "string") {
    parts.push(truncateAddress(details.txid, 8, 8));
  }
  if (details.continuation === true) parts.push("continuation");
  if (details.cron === true) parts.push("cron");
  if (typeof details.pendingTxidsCount === "number" && details.pendingTxidsCount > 0) {
    parts.push(`${details.pendingTxidsCount} tx pending`);
  }
  if (typeof details.processedIndex === "number") {
    const pending =
      typeof details.pendingTxidsCount === "number" ? details.pendingTxidsCount : 0;
    if (pending > 0) {
      parts.push(`progress ${details.processedIndex}/${pending}`);
    } else {
      parts.push(`processed ${details.processedIndex}`);
    }
  } else if (typeof details.chunkIndex === "number" && typeof details.chunkTotal === "number") {
    parts.push(`progress ${details.chunkIndex}/${details.chunkTotal}`);
  }
  if (details.traceEdgesPending === true) parts.push("trace pending");
  if (typeof details.traceEdgeIndex === "number") {
    parts.push(`trace edge ${details.traceEdgeIndex}`);
  }

  if (parts.length === 0) {
    if (type === "sync_coldcardwatch") return "External sync";
    if (type === "sync_vercel_trackers") return "Tracker sync";
    if (type === "refresh_btc_usd_price") return "BTC/USD price";
    return "—";
  }

  const syncParts: string[] = [];
  if (type === "sync_coldcardwatch") syncParts.push("External sync");
  if (type === "sync_vercel_trackers") syncParts.push("Tracker sync");
  if (typeof details.source === "string" && details.source.length > 0) {
    syncParts.push(formatSyncSourceLabel(details.source));
  }

  if (syncParts.length > 0) {
    const tail = details.finalize === true ? [...parts, "finalize"] : parts;
    return [...syncParts, ...tail].join(" · ");
  }

  if (details.finalize === true) parts.push("finalize");

  return parts.join(" · ");
}

export function jobClassBorderClass(jobClass: QueueJobClass): string {
  switch (jobClass) {
    case "ingest":
      return "queue-job-card--ingest";
    case "cosmetic":
      return "queue-job-card--cosmetic";
    default:
      return "queue-job-card--maint";
  }
}

export function formatRunningElapsed(startedAt: string | null, nowMs: number): string | null {
  if (!startedAt) return null;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  const elapsedMs = nowMs - startMs;
  if (elapsedMs < 0) return null;
  if (elapsedMs < 1000) return `${Math.round(elapsedMs)}ms`;
  const totalSec = elapsedMs / 1000;
  if (totalSec < 60) {
    const rounded = totalSec >= 10 ? Math.round(totalSec) : Math.round(totalSec * 10) / 10;
    return `${rounded}s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatCount(n: number): string {
  const abs = Math.abs(Math.round(n));
  const withCommas = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${withCommas}` : withCommas;
}

function formatRelativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function formatPruneEta(sec: number): string {
  if (sec <= 0) return "now";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${sec}s`;
}

function maintenancePhaseLabel(phase?: string): string {
  switch (phase) {
    case "backfill_completed_at":
      return "backfilling job timestamps";
    case "prune_done_jobs":
      return "pruning done jobs";
    case "rate_limits":
      return "cleaning rate limits";
    case "sync_state_orphans":
      return "cleaning orphan sync state";
    default:
      return "maintenance";
  }
}

function remainingForPhase(phase: string | undefined, remaining: MaintenanceStatus["remaining"]): number | undefined {
  if (!remaining) return undefined;
  switch (phase) {
    case "backfill_completed_at":
      return remaining.backfill;
    case "prune_done_jobs":
      return remaining.pruneJobs;
    case "rate_limits":
      return remaining.rateLimits;
    case "sync_state_orphans":
      return remaining.syncOrphans;
    default:
      return remaining.total;
  }
}

function doneForPhase(phase: string | undefined, progress: MaintenanceStatus["progress"]): number | undefined {
  if (!progress) return undefined;
  switch (phase) {
    case "backfill_completed_at":
      return progress.completedAtBackfillUpdated;
    case "prune_done_jobs":
      return progress.jobsDeleted;
    case "rate_limits":
      return progress.rateLimitsDeleted;
    case "sync_state_orphans":
      return progress.syncStateOrphansDeleted;
    default:
      return undefined;
  }
}

function doneUnit(phase: string | undefined): string {
  switch (phase) {
    case "backfill_completed_at":
      return "backfilled";
    case "rate_limits":
      return "rate limits";
    case "sync_state_orphans":
      return "orphans";
    default:
      return "deleted";
  }
}

export function formatMaintenanceLine(maintenance: MaintenanceStatus, nowMs: number): string {
  if (!maintenance.enabled || maintenance.status === "disabled") {
    return "Auto-prune: off";
  }
  if (maintenance.status === "running" || maintenance.pending) {
    if (!maintenance.phase) {
      return "Auto-prune: waiting to resume";
    }
    const phase = maintenancePhaseLabel(maintenance.phase);
    const parts: string[] = [`Auto-prune: running — ${phase}`];
    const done = doneForPhase(maintenance.phase, maintenance.progress);
    if (done) parts.push(`${formatCount(done)} ${doneUnit(maintenance.phase)}`);
    const left = remainingForPhase(maintenance.phase, maintenance.remaining);
    if (left != null && left > 0) parts.push(`~${formatCount(left)} left`);
    return parts.join(" · ");
  }
  const last = maintenance.lastPrunedAt
    ? `last run ${formatRelativeTime(maintenance.lastPrunedAt, nowMs)}`
    : "scheduled";
  let next = "";
  if (maintenance.nextPruneAt) {
    const sec = Math.max(0, Math.ceil((new Date(maintenance.nextPruneAt).getTime() - nowMs) / 1000));
    next = ` · next ~${formatPruneEta(sec)}`;
  }
  return `Auto-prune: ${last}${next} (${maintenance.retentionDays}d retention, every ${maintenance.intervalDays}d)`;
}

export function formatMaintenanceTooltip(maintenance: MaintenanceStatus, nowMs: number): string {
  const lines = [
    `Retention: ${maintenance.retentionDays}d`,
    `Interval: every ${maintenance.intervalDays}d`,
    `Last run: ${maintenance.lastPrunedAt ? formatRelativeTime(maintenance.lastPrunedAt, nowMs) : "never"}`,
  ];
  if (maintenance.nextPruneAt && !maintenance.pending) {
    const sec = Math.max(0, Math.ceil((new Date(maintenance.nextPruneAt).getTime() - nowMs) / 1000));
    lines.push(`Next run: ~${formatPruneEta(sec)}`);
  }
  const r = maintenance.remaining;
  if (r) {
    lines.push(
      `Remaining: timestamps ${formatCount(r.backfill)}, jobs ${formatCount(r.pruneJobs)}, rate limits ${formatCount(r.rateLimits)}, orphans ${formatCount(r.syncOrphans)}`,
    );
  }
  return lines.join("\n");
}
