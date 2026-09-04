import { useEffect, useMemo, useState } from "react";
import type { MonitoringSyncStatus } from "./MonitoringIndicator";
import type { QueueSnapshot } from "../lib/queueApi";
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
