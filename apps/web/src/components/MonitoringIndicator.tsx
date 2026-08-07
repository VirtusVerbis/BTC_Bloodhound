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
}

const SOURCE_LABELS: Record<string, string> = {
  coldcardwatch: "coldcardwatch.com",
  coldcard_hack_tracker: "coldcard-hack-tracker.vercel.app",
  coldcard_sweep_watch: "coldcard-watch.vercel.app",
};

function formatLocal(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function monitoringTooltip(sync: MonitoringSyncStatus) {
  return [
    `Chain API: ${formatLocal(sync.lastChainApiAt)}`,
    `External sync: ${formatLocal(sync.lastExternalSyncAt)}`,
    `Indexer jobs: ${formatLocal(sync.lastJobAt)}`,
  ].join("\n");
}

interface MonitoringIndicatorProps {
  sync: MonitoringSyncStatus | null;
  onNavigateMonitoring: () => void;
}

export function MonitoringIndicator({ sync, onNavigateMonitoring }: MonitoringIndicatorProps) {
  const active = sync?.monitoringActive !== false;
  const lastActivity = sync?.lastActivityAt;

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

export function formatSourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? source;
}

export { formatLocal as formatMonitoringTime };
