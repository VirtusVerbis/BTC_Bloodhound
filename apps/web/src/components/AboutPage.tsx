import {
  apiReferences,
  dataSourceLinks,
  dataSourceNote,
  disclaimerItems,
  hackCoverageLinks,
  keyboardCommands,
  monitoredExternalSites,
  monitoringIntro,
  openSourceRepoUrl,
  purposeText,
} from "../content/aboutContent";
import {
  formatJobDuration,
  formatMonitoringTime,
  formatSourceLabel,
  type MonitoringSyncStatus,
} from "./MonitoringIndicator";

function ExternalLinkList({ links }: { links: { label: string; url: string; description?: string }[] }) {
  return (
    <ul className="about-link-list">
      {links.map((link) => (
        <li key={link.url}>
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
          {link.description && <span className="about-link-desc"> — {link.description}</span>}
        </li>
      ))}
    </ul>
  );
}

interface AboutPageProps {
  sync?: MonitoringSyncStatus | null;
}

export function AboutPage({ sync }: AboutPageProps) {
  return (
    <div className="about-panel">
      <section className="about-section about-disclaimer">
        <h2>Disclaimer</h2>
        <ul>
          {disclaimerItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="about-section">
        <h2>Open Source Repo</h2>
        <p>
          <a href={openSourceRepoUrl} target="_blank" rel="noopener noreferrer">
            {openSourceRepoUrl}
          </a>
        </p>
      </section>

      <section className="about-section">
        <h2>Purpose</h2>
        <p>{purposeText}</p>
      </section>

      <section className="about-section">
        <h2>Keyboard commands</h2>
        <ul className="about-link-list">
          {keyboardCommands.map((cmd) => (
            <li key={cmd.key}>
              <kbd>{cmd.key}</kbd> — {cmd.description}
            </li>
          ))}
        </ul>
      </section>

      <section className="about-section">
        <h2>Hack coverage</h2>
        <ExternalLinkList links={hackCoverageLinks} />
      </section>

      <section className="about-section" id="monitoring">
        <h2>Monitoring</h2>
        <p>{monitoringIntro}</p>
        <p>Actively polled external tracker sites:</p>
        <ul className="about-link-list">
          {monitoredExternalSites.map((site) => (
            <li key={site.host}>
              <a href={`https://${site.host}`} target="_blank" rel="noopener noreferrer">
                {site.host}
              </a>
              <span className="about-link-desc"> — {site.label}</span>
            </li>
          ))}
        </ul>
        {sync && (
          <div className="about-monitoring-status">
            <p>
              <strong>Status:</strong> {sync.monitoringActive !== false ? "Active" : "Paused (no recent activity)"}
            </p>
            <p>
              <strong>Last activity:</strong> {formatMonitoringTime(sync.lastActivityAt)}
            </p>
            <ul className="about-link-list about-monitoring-breakdown">
              <li>Chain API: {formatMonitoringTime(sync.lastChainApiAt)}</li>
              <li>External sync: {formatMonitoringTime(sync.lastExternalSyncAt)}</li>
              <li>Indexer jobs: {formatMonitoringTime(sync.lastJobAt)}</li>
              <li>
                Last job completed: {sync.lastCompletedJobType?.trim() || "—"}
                {" · "}
                Duration: {formatJobDuration(sync.lastCompletedJobDurationMs)}
              </li>
            </ul>
            {sync.externalSources && sync.externalSources.length > 0 && (
              <>
                <p>Per-source last sync:</p>
                <ul className="about-link-list about-monitoring-breakdown">
                  {sync.externalSources.map((s) => (
                    <li key={s.source}>
                      {formatSourceLabel(s.source)}: {formatMonitoringTime(s.lastSyncAt)}
                      {s.lastAddressCount != null ? ` (${s.lastAddressCount} addresses)` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      <section className="about-section">
        <h2>Data sources</h2>
        <ExternalLinkList links={dataSourceLinks} />
        <p className="about-note">{dataSourceNote}</p>
      </section>

      <section className="about-section">
        <h2>APIs used</h2>
        <ul className="about-link-list">
          {apiReferences.map((api) => (
            <li key={api.name}>
              <strong>{api.name}</strong>
              {" — "}
              <a href={api.baseUrl} target="_blank" rel="noopener noreferrer">
                {api.baseUrl}
              </a>
              {" · "}
              <a href={api.docsUrl} target="_blank" rel="noopener noreferrer">
                API docs
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
