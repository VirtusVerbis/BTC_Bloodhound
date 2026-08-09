import { formatSourceLabel } from "../lib/hackerGroups";

export interface MonitoringSyncSource {
  source: string;
  lastSyncAt: string | null;
  lastAddressCount: number | null;
}

export interface MonitoringSyncStatus {
  monitoringActive?: boolean;
  lastActivityAt?: string | null;
  lastChainApiAt?: string | null;
  lastExternalSyncAt?: string | null;
  lastJobAt?: string | null;
  lastCompletedJobType?: string | null;
  lastCompletedJobDurationMs?: number | null;
  lastCompletedJobAt?: string | null;
  externalSources?: MonitoringSyncSource[];
  apiThresholdExceeded?: boolean;
  lastApiThresholdAt?: string | null;
  apiThresholdCount?: number;
}

function formatLocal(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Format job execution duration for monitoring display. */
export function formatJobDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    const rounded = totalSec >= 10 ? Math.round(totalSec) : Math.round(totalSec * 10) / 10;
    return `${rounded}s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatLastCompletedJob(sync: MonitoringSyncStatus): string {
  const type = sync.lastCompletedJobType?.trim() || "—";
  const duration = formatJobDuration(sync.lastCompletedJobDurationMs);
  return `Last Job Completed: ${type}  Duration: ${duration}`;
}

function monitoringTooltip(sync: MonitoringSyncStatus) {
  const lines = [
    `Chain API: ${formatLocal(sync.lastChainApiAt)}`,
    `External sync: ${formatLocal(sync.lastExternalSyncAt)}`,
    `Indexer jobs: ${formatLocal(sync.lastJobAt)}`,
    formatLastCompletedJob(sync),
  ];
  if (sync.apiThresholdExceeded) {
    lines.push(
      `API threshold hit: ${formatLocal(sync.lastApiThresholdAt)} (${sync.apiThresholdCount ?? 0} total)`,
    );
  }
  return lines.join("\n");
}

interface MonitoringIndicatorProps {
  sync: MonitoringSyncStatus | null;
  onNavigateMonitoring: () => void;
  rateLimitSecondsLeft?: number | null;
}

export function MonitoringIndicator({
  sync,
  onNavigateMonitoring,
  rateLimitSecondsLeft = null,
}: MonitoringIndicatorProps) {
  const active = sync?.monitoringActive !== false;
  const lastActivity = sync?.lastActivityAt;
  const thresholdExceeded = sync?.apiThresholdExceeded === true;
  const showRateLimit = rateLimitSecondsLeft != null && rateLimitSecondsLeft > 0;

  return (
    <div className="monitoring-indicator">
      <a
        href="#monitoring"
        className="monitoring-indicator-link"
        title={sync ? monitoringTooltip(sync) : "Background monitoring status"}
        onClick={(e) => {
          e.preventDefault();
          onNavigateMonitoring();
        }}
      >
        {thresholdExceeded && (
          <span
            className="monitoring-threshold-warning"
            title={`Last hit: ${formatLocal(sync?.lastApiThresholdAt)} · ${sync?.apiThresholdCount ?? 0} total`}
          >
            API Thresholds Exceeded!
          </span>
        )}
        <span
          className={`monitoring-dot${active ? " monitoring-dot--active" : " monitoring-dot--paused"}`}
          aria-hidden
        />
        <span className="monitoring-label">{active ? "Monitoring" : "Monitoring paused"}</span>
      </a>
      <div className="monitoring-updated">
        Last updated: {lastActivity ? formatLocal(lastActivity) : "—"}
      </div>
      <div className="monitoring-updated">
        {sync ? formatLastCompletedJob(sync) : "Last Job Completed: —  Duration: —"}
      </div>
      {showRateLimit && (
        <div className="rate-limit-banner" role="status">
          Rate limit active — too many requests. Try again in {rateLimitSecondsLeft}s.
        </div>
      )}
    </div>
  );
}

export { formatSourceLabel };

export { formatLocal as formatMonitoringTime };
