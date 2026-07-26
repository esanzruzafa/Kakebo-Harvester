import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Application",
  description:
    "Download, user guide, features and FAQ for the Kakebo Harvester Windows application."
};

const releaseUrl =
  "https://github.com/esanzruzafa/Kakebo-Harvester/releases/latest";
const repositoryUrl = "https://github.com/esanzruzafa/Kakebo-Harvester";

export default function ApplicationPage() {
  return (
    <div lang="en" className="product-shell">
      <section className="product-hero">
        <p className="eyebrow">Open-source Windows application</p>
        <h1>Your banking data, prepared locally.</h1>
        <p className="hero-copy">
          Kakebo Harvester retrieves read-only Open Banking data, keeps it on
          your computer, and creates a configurable XLSX or CSV file for private
          analysis.
        </p>
        <div className="hero-actions">
          <a className="download-link" href={releaseUrl}>
            Download the latest release
          </a>
          <a className="secondary-link" href={repositoryUrl}>
            View source on GitHub
          </a>
        </div>
        <p className="release-note">
          Windows x64 · Portable · No Node.js installation required · Releases
          include a SHA-256 checksum
        </p>
      </section>

      <section className="product-section">
        <p className="eyebrow">What it does</p>
        <h2>A focused local workflow</h2>
        <div className="feature-grid">
          <article>
            <strong>01</strong>
            <h3>Synchronize</h3>
            <p>
              Choose a date range and retrieve accounts, balances and movements.
              Expired bank consent is renewed in the system browser.
            </p>
          </article>
          <article>
            <strong>02</strong>
            <h3>Organize</h3>
            <p>
              Add account aliases and maintain ordered categorization rules with
              dependent category and subcategory lists.
            </p>
          </article>
          <article>
            <strong>03</strong>
            <h3>Export</h3>
            <p>
              Choose XLSX or CSV, fields, order, column names and regional CSV
              separators without changing source code.
            </p>
          </article>
          <article>
            <strong>04</strong>
            <h3>Audit</h3>
            <p>
              Review persistent runs and the account balance snapshot captured
              for every execution.
            </p>
          </article>
        </div>
      </section>

      <section className="product-section guide-section">
        <p className="eyebrow">Getting started</p>
        <h2>Portable folder setup</h2>
        <ol className="guide-steps">
          <li>
            Download the latest portable executable from GitHub Releases.
          </li>
          <li>
            Place it in a private folder together with your completed
            <code>.env.production</code>.
          </li>
          <li>
            Keep the production PEM under <code>private/</code>. Configuration
            is stored under <code>config/</code> and data under
            <code>data/production/</code>.
          </li>
          <li>
            Start the executable and allow it to prepare local HTTPS for your
            Windows user.
          </li>
          <li>
            Run Doctor, complete bank authorization, and test a short manual
            synchronization.
          </li>
        </ol>
        <div className="notice">
          The portable executable never contains your credentials, PEM file,
          encryption key, database or exported results. Preserve the complete
          private folder when moving to another computer.
        </div>
      </section>

      <section className="product-section">
        <p className="eyebrow">Frequently asked questions</p>
        <h2>FAQ</h2>
        <div className="faq-list">
          <details>
            <summary>Can Kakebo Harvester move money?</summary>
            <p>
              No. It uses read-only account-information access and does not
              implement payment or transfer endpoints.
            </p>
          </details>
          <details>
            <summary>Where is my data stored?</summary>
            <p>
              On your computer, in the SQLite database and optional raw-data
              directory configured in <code>.env.production</code>.
            </p>
          </details>
          <details>
            <summary>What happens when I change the export profile?</summary>
            <p>
              On the next export, a result created with a different profile is
              moved to the archive folder before the new file is written.
            </p>
          </details>
          <details>
            <summary>Can it run automatically?</summary>
            <p>
              Yes. The executable exposes a non-interactive
              <code>--scheduled-sync</code> mode for Windows Task Scheduler.
              Expired consent returns a dedicated exit code and never opens a
              browser in scheduled mode.
            </p>
          </details>
          <details>
            <summary>How do I move it to another computer?</summary>
            <p>
              Close the app, copy the complete private application folder, and
              regenerate local HTTPS for the new Windows user. No source-code
              change is required.
            </p>
          </details>
          <details>
            <summary>Why might my bank or account be missing?</summary>
            <p>
              Coverage and account types depend on the bank and PSD2 interface.
              Investments, loans, insurance and some cards may not be exposed.
            </p>
          </details>
        </div>
      </section>
    </div>
  );
}
