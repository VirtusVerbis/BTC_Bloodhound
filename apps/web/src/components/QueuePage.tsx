import { useEffect, useMemo, useState } from "react";
import type { MonitoringSyncStatus, MaintenanceStatus } from "./MonitoringIndicator";
import type { QueueSnapshot } from "../lib/queueApi";
import {
  formatCountdown,
  formatHoursMinutesCountdown,
} from "./MonitoringIndicator";
import {
  formatJobDetailLine,
  formatJobPriorityBadge,
  formatJobTypeLabel,
  formatJobWaitDuration,
  formatRunningElapsed,
  formatSnapshotAge,
  jobClassBorderClass,
} from "../lib/queueFormat";

interface QueuePageProps {
  sync: (MonitoringSyncStatus & { queueDepth?: number }) | null;
  snapshot: QueueSnapshot | null;
  snapshotFetchedAt: number | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const SNAPSHOT_TOOLTIP =
  "Refreshes when an indexer job completes. Running job details update on completion slices only.";

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

function formatMaintenanceLine(maintenance: MaintenanceStatus, nowMs: number): string {
  if (!maintenance.enabled || maintenance.status === "disabled") {
    return "Auto-prune: off";
  }
  if (maintenance.status === "running" || maintenance.pending) {
    const phase = maintenancePhaseLabel(maintenance.phase);
    const parts: string[] = [`Auto-prune: running — ${phase}`];
    const p = maintenance.progress;
    if (p?.jobsDeleted) parts.push(`${p.jobsDeleted} jobs deleted`);
    if (p?.completedAtBackfillUpdated) parts.push(`${p.completedAtBackfillUpdated} timestamps backfilled`);
    if (p?.rateLimitsDeleted) parts.push(`${p.rateLimitsDeleted} rate limits`);
    if (p?.syncStateOrphansDeleted) parts.push(`${p.syncStateOrphansDeleted} sync orphans`);
    return parts.join(" · ");
  }
  if (maintenance.status === "scheduled" && maintenance.nextPruneAt) {
    const sec = Math.max(0, Math.ceil((new Date(maintenance.nextPruneAt).getTime() - nowMs) / 1000));
    const eta = sec >= 86400 ? formatHoursMinutesCountdown(sec) : formatCountdown(sec);
    return `Auto-prune: next run ~${eta} (${maintenance.retentionDays}d retention, every ${maintenance.intervalDays}d)`;
  }
  if (maintenance.lastPrunedAt) {
    return `Auto-prune: last run ${formatRelativeTime(maintenance.lastPrunedAt, nowMs)} (${maintenance.retentionDays}d retention)`;
  }
  return `Auto-prune: scheduled (${maintenance.intervalDays}d interval, ${maintenance.retentionDays}d retention)`;
}

function topTypesByCount(byType: Record<string, number>, limit = 5) {
  return Object.entries(byType)
    .sort(([, a], [, b]) => b - a || 0)
    .slice(0, limit);
}

function typeSummaryTooltip(byType: Record<string, number>) {
  return Object.entries(byType)
    .sort(([, a], [, b]) => b - a || 0)
    .map(([type, count]) => `${formatJobTypeLabel(type)}: ${count}`)
    .join("\n");
}

export function QueuePage({
  sync,
  snapshot,
  snapshotFetchedAt,
  loading,
  error,
  onRetry,
}: QueuePageProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const snapshotAge = snapshotFetchedAt != null ? nowMs - snapshotFetchedAt : null;
  const runningCount = snapshot?.summary.byStatus.running ?? 0;
  const queueDepth = snapshot?.context.queueDepth ?? sync?.queueDepth ?? 0;
  const draining = sync?.queueSchedulingPaused === true || snapshot?.context.queueSchedulingPaused;
  const hiddenCount = snapshot ? Math.max(0, snapshot.summary.total - snapshot.jobs.length) : 0;

  const typeRows = useMemo(
    () => (snapshot ? topTypesByCount(snapshot.summary.byType) : []),
    [snapshot],
  );

  return (
    <div className="queue-panel">
      <section className="queue-meta" aria-label="Queue status">
        <p className="queue-meta-line">
          Queue: {queueDepth} runnable · {runningCount} running
          {snapshot?.context.rebuildActive && (
            <span className="queue-rebuild-badge" title="Indexer rebuild mode active">
              {" "}
              · rebuild active
            </span>
          )}
        </p>
        {draining && (
          <p className="about-queue-draining" role="status">
            Queue draining — new work paused until backlog clears
          </p>
        )}
        <p className="queue-meta-updated" title={SNAPSHOT_TOOLTIP}>
          Snapshot updated {formatSnapshotAge(snapshotAge)}
        </p>
        {sync?.maintenance && (
          <p
            className={[
              "queue-maintenance-line",
              sync.maintenance.pending ? "queue-maintenance-line--running" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="status"
          >
            {formatMaintenanceLine(sync.maintenance, nowMs)}
          </p>
        )}
      </section>

      {error && (
        <div className="inline-error queue-error">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {loading && !snapshot && <p className="inline-status">Loading queue…</p>}

      {snapshot && typeRows.length > 0 && (
        <section className="queue-summary" aria-label="Jobs by type">
          <h2 className="queue-section-title">By type</h2>
          <table className="queue-summary-table" title={typeSummaryTooltip(snapshot.summary.byType)}>
            <thead>
              <tr>
                <th>Type</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {typeRows.map(([type, count]) => (
                <tr key={type}>
                  <td>{formatJobTypeLabel(type)}</td>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {snapshot && snapshot.jobs.length > 0 && (
        <section className="queue-stack" aria-label="Top queue jobs">
          <h2 className="queue-section-title">Next up</h2>
          <ol className="queue-job-list">
            {snapshot.jobs.map((job, index) => {
              const isRunning = job.status === "running";
              const elapsed = isRunning ? formatRunningElapsed(job.startedAt, nowMs) : null;
              const waitLabel = formatJobWaitDuration(job, nowMs);
              const priorityBadge = formatJobPriorityBadge(job);
              return (
                <li
                  key={job.id}
                  className={[
                    "queue-job-card",
                    jobClassBorderClass(job.jobClass),
                    isRunning ? "queue-job-card--running" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <div className="queue-job-header">
                    <span className="queue-job-position">#{index + 1}</span>
                    {isRunning && <span className="queue-job-running-badge">RUNNING</span>}
                    <span className="queue-job-type">{formatJobTypeLabel(job.type)}</span>
                    <span className="queue-job-class">{job.jobClass}</span>
                    <span
                      className={[
                        "queue-job-priority",
                        priorityBadge.boosted ? "queue-job-priority--boosted" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      title={priorityBadge.title}
                    >
                      {priorityBadge.label}
                    </span>
                  </div>
                  <div className="queue-job-detail">{formatJobDetailLine(job)}</div>
                  {waitLabel && <div className="queue-job-wait">waiting {waitLabel}</div>}
                  {elapsed && <div className="queue-job-elapsed">running {elapsed}</div>}
                  {!job.runAfterDue && job.status === "pending" && (
                    <div className="queue-job-deferred">scheduled · not yet due</div>
                  )}
                </li>
              );
            })}
          </ol>
          {(snapshot.truncated || hiddenCount > 0) && (
            <p className="queue-more">+{hiddenCount} more jobs not shown</p>
          )}
        </section>
      )}

      {snapshot && snapshot.jobs.length === 0 && !loading && (
        <p className="inline-status">Queue is idle — no pending or running jobs.</p>
      )}
    </div>
  );
}
