import {
  apiReferences,
  contactLinks,
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
import { formatQuotaCount } from "../lib/quotaFormat";
import {
  loadMonitoringCache,
  mergeMonitoringForAbout,
  type AboutMonitoringInput,
} from "../lib/monitoringCache";
import {
  formatCountdown,
  formatJobDuration,
  formatMonitoringTime,
  formatSourceLabel,
  type ChainApiStatus,
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
  sync?: AboutMonitoringInput | null;
}

export function AboutPage({ sync }: AboutPageProps) {
  const display = mergeMonitoringForAbout(sync, loadMonitoringCache());
  const monitoring = display.data;
  const isCached = display.source === "cached";

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
        <h2>Contact</h2>
        <ExternalLinkList links={contactLinks} />
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
        {monitoring && (
          <div className="about-monitoring-status">
            {isCached && display.retrievedAt && (
              <p className="about-monitoring-stale" role="status">
                Database unavailable — values last retrieved{" "}
                {formatMonitoringTime(display.retrievedAt)}
              </p>
            )}
            <p>
              <strong>Status:</strong>{" "}
              {monitoring.monitoringActive !== false ? "Active" : "Paused (no recent activity)"}
            </p>
            <p>
              <strong>Last activity:</strong> {formatMonitoringTime(monitoring.lastActivityAt)}
            </p>
            <ul className="about-link-list about-monitoring-breakdown">
              <li>Chain API: {formatMonitoringTime(monitoring.lastChainApiAt)}</li>
              <li>External sync: {formatMonitoringTime(monitoring.lastExternalSyncAt)}</li>
              <li>Indexer jobs: {formatMonitoringTime(monitoring.lastJobAt)}</li>
              <li>
                Last job completed: {monitoring.lastCompletedJobType?.trim() || "—"}
                {" · "}
                Duration: {formatJobDuration(monitoring.lastCompletedJobDurationMs)}
              </li>
              {monitoring.d1Quota && (
                <>
                  <li>
                    D1 reads: {formatQuotaCount(monitoring.d1Quota.rowsRead)}/
                    {formatQuotaCount(monitoring.d1Quota.rowsReadLimit)}
                  </li>
                  <li>
                    D1 writes: {formatQuotaCount(monitoring.d1Quota.rowsWritten)}/
                    {formatQuotaCount(monitoring.d1Quota.rowsWrittenLimit)}
                  </li>
                  <li>
                    Requests: {formatQuotaCount(monitoring.d1Quota.workersRequests)}/
                    {formatQuotaCount(monitoring.d1Quota.workersRequestsLimit)}
                  </li>
                </>
              )}
            </ul>
            {monitoring.externalSources && monitoring.externalSources.length > 0 && (
              <>
                <p>Per-source last sync:</p>
                <ul className="about-link-list about-monitoring-breakdown">
                  {monitoring.externalSources.map((s) => (
                    <li key={s.source}>
                      {formatSourceLabel(s.source)}: {formatMonitoringTime(s.lastSyncAt)}
                      {s.lastAddressCount != null ? ` (${s.lastAddressCount} addresses)` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {monitoring.chainApis && monitoring.chainApis.length > 0 && (
              <>
                <p>Chain API status:</p>
                <ul className="about-link-list about-monitoring-breakdown about-chain-api-status">
                  {monitoring.chainApis.map((api: ChainApiStatus) => (
                    <li key={api.id}>
                      <strong>{api.label}:</strong>{" "}
                      {api.thresholdExceeded ? (
                        <span className="chain-api-threshold">
                          {isCached ? (
                            <>Rate limited (at last check)</>
                          ) : (
                            <>
                              Rate limited — retry in {formatCountdown(api.thresholdSecondsLeft)}
                            </>
                          )}
                          {api.strikeCount != null && api.strikeCount > 0
                            ? ` (strike ${api.strikeCount})`
                            : ""}
                        </span>
                      ) : (
                        <span className="chain-api-active">Active</span>
                      )}
                      {api.thresholdCount > 0 && (
                        <span className="about-link-desc">
                          {" "}
                          ({api.thresholdCount} threshold hit{api.thresholdCount === 1 ? "" : "s"} total)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {monitoring.queueSchedulingPaused && (
              <p className="about-queue-draining">
                Queue scheduling is paused (cap {monitoring.maxQueueDepth ?? "—"}) until the pending job
                backlog drains to zero.
              </p>
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
