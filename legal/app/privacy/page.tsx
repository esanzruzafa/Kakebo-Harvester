export const metadata = {
  title: "Privacy policy",
  description: "Privacy policy for the Kakebo Harvester application."
};

export default function PrivacyPage() {
  return (
    <div className="legal-shell" lang="en">
      <aside className="legal-aside">
        <p className="eyebrow">Document 01</p>
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
        <h1>Privacy policy</h1>

        <div className="notice">
          Kakebo Harvester is a local and read-only application. It cannot
          initiate payments, transfers or other financial operations.
        </div>

        <h2>1. Data controller</h2>
        <p>
          The data controller for Kakebo Harvester is Eduardo Sanz, residing in
          Spain. For any privacy enquiry, contact{" "}
          <a href="mailto:kakebo.harvester@gmail.com">
            kakebo.harvester@gmail.com
          </a>
          .
        </p>

        <h2>2. Information processed</h2>
        <p>
          When you authorise a bank connection, the application may retrieve the
          data made available by the institution through PSD2/Open Banking:
        </p>
        <ul>
          <li>Descriptive information and currency of authorised accounts.</li>
          <li>Balances and their reference dates.</li>
          <li>
            Transactions, amounts, dates, descriptions and counterparties when
            available.
          </li>
          <li>
            Technical identifiers needed to maintain the session and prevent
            duplicates.
          </li>
        </ul>
        <p>
          Account numbers are masked in the internal model and are not included
          in full in analysis exports.
        </p>

        <h2>3. Purpose and legal basis</h2>
        <p>
          Information is used solely to import and organise the user&apos;s
          personal finances, produce an export suitable for Kakebo analysis and
          maintain authorised synchronisations. Access is based on the consent
          granted during the bank authorisation process and, where applicable,
          on providing the service requested by the user.
        </p>

        <h2>4. Data sources and providers</h2>
        <p>
          Data comes from the financial institutions expressly authorised by
          the user and is retrieved through Enable Banking, an AISP/Open Banking
          connectivity provider. The bank and Enable Banking apply their own
          terms and privacy policies to their respective processing activities.
        </p>

        <h2>5. Storage and security</h2>
        <p>
          Kakebo Harvester runs locally. Its database, transactions and exports
          remain on the user&apos;s computer. Session identifiers are encrypted
          locally, account identifiers are masked and files containing financial
          data are excluded from the source-code repository.
        </p>
        <p>
          The application does not sell data, include advertising or send
          financial telemetry to third parties.
        </p>

        <h2>6. Retention</h2>
        <p>
          Sessions are retained while consent remains valid or until it is
          revoked. Historical transactions may remain locally to preserve the
          user&apos;s Kakebo records until the user deletes them. Optional raw
          diagnostic responses can be disabled and removed from the computer.
        </p>

        <h2>7. Rights and withdrawal of consent</h2>
        <p>
          You may request access, rectification, erasure, restriction,
          objection or portability by contacting the address above. You may
          also withdraw consent through your bank or Enable Banking&apos;s
          consent management. Withdrawal does not affect processing lawfully
          carried out beforehand.
        </p>
        <p>
          If you believe that the processing breaches applicable law, you may
          contact the{" "}
          <a href="https://www.aepd.es/en" rel="noreferrer">
            Spanish Data Protection Agency
          </a>
          .
        </p>

        <h2>8. Changes</h2>
        <p>
          This policy may be updated if the application or applicable law
          changes. The effective version date appears at the beginning of this
          document.
        </p>
      </article>
    </div>
  );
}
