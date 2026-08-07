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

function monitoringTooltip(sync: MonitoringSyncStatus) {
  const lines = [
    `Chain API: ${formatLocal(sync.lastChainApiAt)}`,
    `External sync: ${formatLocal(sync.lastExternalSyncAt)}`,
    `Indexer jobs: ${formatLocal(sync.lastJobAt)}`,
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
}

export function MonitoringIndicator({ sync, onNavigateMonitoring }: MonitoringIndicatorProps) {
  const active = sync?.monitoringActive !== false;
  const lastActivity = sync?.lastActivityAt;
  const thresholdExceeded = sync?.apiThresholdExceeded === true;

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
    </div>
  );
}

export { formatSourceLabel };

export { formatLocal as formatMonitoringTime };
