# Kakebo Harvester

**Kakebo Harvester** is a local, read-only application that retrieves accounts, balances, and transactions through Enable Banking's AISP API, stores them in SQLite, and generates a stable CSV file for Power Query. It does not initiate payments or transfers, automate banking websites, or request or store credentials, PINs, OTPs, or SMS codes.

The implementation supports sandbox and restricted production environments, which remain fully isolated from one another. Production activation is always a manual step after validating the sandbox configuration.

## Scope and security

- A new RS256 JWT is created for every request and expires after five minutes.
- Session identifiers are encrypted locally with AES-256-GCM.
- Authorization `state` values are random; SQLite stores only their hashes and accepts each one once within 15 minutes.
- Callbacks remain on the local machine: HTTP in sandbox and HTTPS in production.
- Amounts are stored as exact decimal strings and are never calculated with `number`.
- IBANs are masked; neither the normalized model nor the CSV contains a full IBAN.
- Optional raw responses remain outside Git and use restrictive local permissions.
- No telemetry and no payment endpoints.

PSD2 does not guarantee coverage for mortgages, loans, investments, insurance, or every card. Availability, historical depth, and returned fields vary by bank.

## Requirements

- Node.js 20 or later.
- npm.
- An Enable Banking application.
- Excel with Power Query to consume the exported data.

On Windows, native SQLite dependencies may require Visual Studio build tools when no prebuilt binary is available for the installed Node.js version.

## Installation

```powershell
npm install
Copy-Item .env.example .env.sandbox
Copy-Item config/categorization-rules.example.json config/categorization-rules.json
```

Generate the local key used to encrypt sessions:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy the result into `SESSION_ENCRYPTION_KEY` in `.env.sandbox`. Protect that file with your user permissions and keep a secure backup of the key: stored sessions cannot be decrypted if it is lost.

When only one environment file exists, the application selects it automatically. If both `.env.sandbox` and `.env.production` exist, select the intended file explicitly in each terminal:

```powershell
$env:KAKEBO_ENV_FILE = ".env.sandbox"
```

## Create and test a sandbox application

1. Register in the Enable Banking Control Panel and create a `SANDBOX` application.
2. Register exactly `http://localhost:8000/callback` as its redirect URL.
3. Download the PEM file and move it to `private/enable-banking-sandbox.pem`.
4. Copy the application ID into `ENABLE_BANKING_APPLICATION_ID`.
5. Review the sandbox paths in `.env.sandbox`.
6. Enable MFA on the Enable Banking account.
7. Run the diagnostic:

```powershell
npm run cli -- doctor
```

List banks and their published user/authentication methods:

```powershell
npm run cli -- banks --country ES
npm run cli -- banks --country ES --search Kutxa
```

Keep the local callback running in one terminal:

```powershell
npm run cli -- server
```

In another terminal using the same `KAKEBO_ENV_FILE`, start the connection:

```powershell
npm run cli -- connect --bank "Kutxabank" --country ES --psu-type personal
```

Open the displayed URL and authenticate only on the official bank page or the Enable Banking flow. In sandbox, use only the test credentials supplied by the `banks` response or Control Panel.

After the callback completes:

```powershell
npm run cli -- connections
npm run cli -- accounts
npm run cli -- initial-sync --from 2026-01-01
```

Individual steps can also be run separately:

```powershell
npm run cli -- sync-accounts
npm run cli -- sync-balances
npm run cli -- sync-transactions
npm run cli -- sync-transactions --from 2026-01-01 --to 2026-07-24
npm run cli -- export
```

By default, `sync-transactions` uses a rolling 15-day window. Pagination stops when a duplicate key is found or `MAX_TRANSACTION_PAGES` is reached.

## Restricted production

Do not reuse the sandbox application, PEM, database, or sessions.

1. Set up the local HTTPS certificate once:

```powershell
npm run setup:https
```

The certificate authority is trusted only for the current Windows user. The PFX file and its passphrase are stored under `private/`, outside Git.

2. Create a separate `PRODUCTION` application in the Enable Banking Control Panel.
3. Register exactly `https://localhost:8000/callback` as its redirect URL.
4. Use **Activate by linking accounts** to link only your own accounts.
5. Store the new PEM as `private/enable-banking-production.pem`.
6. Copy `.env.production.example` to `.env.production`.
7. Complete the application ID and generate a distinct `SESSION_ENCRYPTION_KEY`.
8. Select `.env.production` and run `doctor`.
9. Keep `npm run cli -- server` running during authorization. Production listens over HTTPS; sandbox continues to use HTTP.
10. Authorize the account again through `connect`; the Control Panel account link does not replace API consent.
11. Start with 30 days, validate the data, and extend to 90 days only if the bank supports it.

If authorization succeeds but no accounts appear, confirm that the specific account has been linked to the restricted application.

## CSV and Power Query

The export is written atomically to:

```text
data/<environment>/exports/kakebo_movements.csv
```

It uses UTF-8 with BOM, `;`, ISO dates, and decimal points. A dated backup can be enabled with `EXPORT_KEEP_BACKUP=true`. A fictional example is available in `examples/kakebo_movements.example.csv`.

In Excel, create a query through **Data > Get Data > From Other Sources > Blank Query** and adjust the path:

```powerquery
let
    Source = Csv.Document(
        File.Contents("C:\path\to\kakebo\data\production\exports\kakebo_movements.csv"),
        [Delimiter=";", Encoding=65001, QuoteStyle=QuoteStyle.Csv]
    ),
    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    Types = Table.TransformColumnTypes(
        Headers,
        {
            {"MovementKey", type text},
            {"Date", type date},
            {"ValueDate", type date},
            {"Amount", type number},
            {"Reviewed", type logical},
            {"ImportedAt", type datetimezone}
        },
        "en-US"
    )
in
    Types
```

Name the query `OpenBanking_Raw`. Keep corrections in a separate `Kakebo_Manual_Adjustments` table and combine it through a left join on `MovementKey`. The final table should prefer manual category and subcategory values when present, so CSV refreshes do not erase decisions:

```text
OpenBanking_Raw + Kakebo_Manual_Adjustments + Categorization_Rules
                              ↓
                       Movements_Final
                              ↓
                 Pivot tables and charts
```

The application never modifies the Excel workbook.

## Optional categorization

`config/categorization-rules.json` supports `contains`, `equals`, `startsWith`, and `regex` rules, applied by priority to uppercase, accent-free text. If the file does not exist or no rule matches, the CSV leaves the category blank. The `Reviewed` field prevents an internal refresh from overwriting a reviewed category; primary corrections should remain in Excel.

## Windows Task Scheduler automation

Create a daily task and use the repository as its start-in directory:

- Program: `powershell.exe`
- Arguments: `-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\kakebo\scripts\sync-production.ps1"`
- Frequency: once per day.

The script references only `.env.production` and does not place secrets in arguments. `sync-all` validates the session, refreshes accounts, balances, and transactions, then exports the CSV. It exits with `0` on success and `10` when reauthorization is required. The scheduled task never opens a browser.

## Reauthorization and disconnection

When `connections` shows `REAUTHORIZATION_REQUIRED`, run `connect` manually and complete consent again. In Spain, a new authentication may invalidate the previous session for the same user and TPP.

To disconnect:

```powershell
npm run cli -- disconnect --connection "Kutxabank personal"
```

The command attempts to close the remote session, removes local sessions, and marks the connection as revoked. Historical transactions are retained. Revoke consent from the bank or Enable Banking as appropriate. Removing historical data requires an explicit manual operation on a backup copy.

## Troubleshooting

- `CONFIGURATION_ERROR`: check required values, the local URL, the base64 key, and that every path includes the environment name.
- Local HTTPS error: run `npm run setup:https`, check both `APP_TLS_*` paths, and restart the browser if it was open while the certificate was installed.
- `PRIVATE_KEY_ERROR`: check the path, PKCS#8 PEM format, and user permissions.
- HTTP 401/403: confirm the application ID, PEM, and environment; requests are not retried.
- `SELF_SIGNED_CERT_IN_CHAIN`: on Windows, the application loads system certificate authorities by default before the first connection. This requires Node.js 22.19 or later; on earlier versions, configure `NODE_EXTRA_CA_CERTS` before starting. It can be disabled with `NODE_USE_SYSTEM_CA=0`. Do not disable TLS validation.
- No accounts in restricted production: link the account in the Control Panel, then authorize it through the API.
- `REAUTHORIZATION_REQUIRED`: renew consent manually.
- Unavailable bank or HTTP 429/502/503/504: the application retries with backoff and jitter; try later if it persists.
- Incomplete history: reduce or split the interval; each ASPSP sets its own maximum.
- Rejected callback: `state` expires after 15 minutes and can be used only once.

## Add another bank

No code changes are required. Use `banks`, run `connect` with the name published by the API, and then assign an account alias in SQLite or through a future interface. Each connection keeps its own session, accounts, and audit trail.

## Technical decisions

- Fastify for the local callback and native `fetch` for HTTP.
- `jose` for RS256 JWTs.
- SQLite with versioned migrations and transactions for writes.
- Zod with tolerant external schemas and strict validation for consumed fields.
- Transaction identity based on a stable reference, provider ID, and a SHA-256 fallback fingerprint.
- Pending/booked reconciliation through a second fingerprint without status.
- Raw responses separated from the normalized model and CSV view.
- Monetary values represented as exact decimal strings.

## Known limitations

- Bank coverage and special PSU headers exposed in `required_psu_headers` require bank-specific validation and, where needed, additional support.
- `SESSION_ENCRYPTION_KEY` rotation is not automated.
- Automatic local HTTPS certificate setup uses the Windows certificate store.
- Raw JSON is not encrypted: it is excluded from Git, created with restrictive local permissions, and can be disabled with `RETAIN_RAW_DATA=false`.
- There is no interface for editing aliases; they can be changed directly in `accounts.account_alias`.
- Automatic categorization is deliberately basic.
- Pending/booked reconciliation relies on stable amount, account, date, and counterparty data.

## Manual actions in Enable Banking

- Create separate sandbox and production applications.
- Register the exact redirect URL for each environment.
- Download and protect each PEM file.
- Enable MFA.
- Use fictional users in sandbox.
- Link your own accounts for restricted production.
- Complete each consent flow with the bank.
- Renew or revoke consent when appropriate.

## Development and verification

```powershell
npm run lint
npm run typecheck
npm test
npm run check
```

Tests use ephemeral keys, temporary SQLite databases, fictional fixtures, and mocks; they never call production.

## Official references

- [Quick Start](https://enablebanking.com/docs/api/quick-start/)
- [API Reference](https://enablebanking.com/docs/api/reference/)
- [Control Panel](https://enablebanking.com/docs/api/control-panel/)
- [Restricted production and linked accounts](https://enablebanking.com/docs/api/linked-accounts/)
- [Spanish market specifics](https://enablebanking.com/docs/markets/es/)
- [Official API samples](https://github.com/enablebanking/enablebanking-api-samples)
