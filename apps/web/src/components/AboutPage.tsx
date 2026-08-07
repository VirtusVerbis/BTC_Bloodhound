import {
  apiReferences,
  dataSourceLinks,
  dataSourceNote,
  disclaimerItems,
  hackCoverageLinks,
  purposeText,
} from "../content/aboutContent";

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

export function AboutPage() {
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
        <h2>Purpose</h2>
        <p>{purposeText}</p>
      </section>

      <section className="about-section">
        <h2>Hack coverage</h2>
        <ExternalLinkList links={hackCoverageLinks} />
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
