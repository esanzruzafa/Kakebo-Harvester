export const metadata = {
  title: "Terms of use",
  description: "Terms of use for the Kakebo Harvester application."
};

export default function TermsPage() {
  return (
    <div className="legal-shell" lang="en">
      <aside className="legal-aside">
        <p className="eyebrow">Document 02</p>
        <p>Version: 21 August 2026</p>
        <p>Jurisdiction: Spain</p>
        <p>
          Contact:{" "}
          <a href="mailto:kakebo.harvester@gmail.com">
            kakebo.harvester@gmail.com
          </a>
        </p>
      </aside>
      <article className="legal-document">
        <p className="eyebrow">Kakebo Harvester</p>
        <h1>Terms of use</h1>

        <div className="notice">
          Use Kakebo Harvester lawfully and connect only accounts you are
          authorised to access.
        </div>

        <h2>1. Owner</h2>
        <p>
          Kakebo Harvester is a personal application owned by Eduardo Sanz,
          Spain. The contact address is{" "}
          <a href="mailto:kakebo.harvester@gmail.com">
            kakebo.harvester@gmail.com
          </a>
          .
        </p>

        <h2>2. Service</h2>
        <p>
          The application retrieves authorised accounts, balances and
          transactions through PSD2/Open Banking services, stores them locally
          and produces an export for Kakebo analysis.
        </p>
        <p>
          The service is informational and read-only. It cannot order payments,
          transfers, withdrawals, investments or any other financial operation.
        </p>

        <h2>3. Permitted use</h2>
        <p>
          The Kakebo Harvester source code is distributed under the{" "}
          <a href="https://github.com/esanzruzafa/Kakebo-Harvester/blob/main/LICENSE">
            MIT License
          </a>
          , which governs the rights to use, copy, modify and distribute the
          software.
        </p>
        <ul>
          <li>Lawful use in accordance with the MIT License.</li>
          <li>
            Authorisation only for accounts the user is legally entitled to
            access.
          </li>
          <li>
            Responsible protection of the computer, local keys and banking
            access.
          </li>
        </ul>
        <p>
          The application must not be used to access third-party data without
          authorisation or to breach the terms of a bank or Enable Banking.
        </p>

        <h2>4. Authorisation and revocation</h2>
        <p>
          The user authenticates exclusively within the official environment of
          the bank or Open Banking provider. Kakebo Harvester does not request
          or store passwords, PINs, SMS codes or one-time passwords. Consent may
          expire or be revoked, in which case the connection must be authorised
          again.
        </p>

        <h2>5. Third-party data</h2>
        <p>
          Data availability, history and accuracy depend on each financial
          institution and Enable Banking. Their services are subject to their
          own terms, policies and possible periods of unavailability.
        </p>

        <h2>6. No professional advice</h2>
        <p>
          Balances, categories, budgets and reports are not financial, tax,
          accounting or legal advice. Before making financial decisions, you
          should verify the information with the relevant institution and, when
          appropriate, a qualified professional.
        </p>

        <h2>7. Availability and liability</h2>
        <p>
          The application is provided as-is and may contain errors or be
          affected by changes to banking APIs. Continuous availability and
          access to every product or transaction through PSD2 are not guaranteed.
        </p>
        <p>
          Nothing in these terms limits rights granted by applicable law or
          excludes liability that cannot legally be excluded.
        </p>

        <h2>8. Termination</h2>
        <p>
          The user may stop using the application, disconnect sessions and
          revoke consent through the bank or Enable Banking. Local data can be
          deleted from the computer under the user&apos;s control.
        </p>

        <h2>9. Governing law and changes</h2>
        <p>
          These terms are governed by Spanish law. Updates will be published on
          this page with the effective version date.
        </p>
      </article>
    </div>
  );
}
