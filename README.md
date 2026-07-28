# Kakebo Harvester

Kakebo Harvester is a local, read-only Windows application that retrieves accounts, balances, and transactions through Enable Banking's AISP API. It stores normalized data in SQLite and exports a configurable XLSX or CSV file for private analysis.

It cannot initiate payments or transfers. Bank credentials, PINs, OTPs, and SMS codes are entered only on the bank or Enable Banking website in the system browser.

The project website, user guide, FAQ, privacy policy, and terms are available in [English](https://esanzruzafa.github.io/Kakebo-Harvester/) and [Spanish](https://esanzruzafa.github.io/Kakebo-Harvester/es/).

## Security model

- Sandbox and production use different applications, PEM files, databases, raw-data folders, and exports.
- Production callbacks use `https://localhost:8000/callback`; sandbox callbacks may use HTTP on localhost.
- A new RS256 JWT is created for every API request and expires after five minutes.
- Provider session identifiers are encrypted locally with AES-256-GCM.
- Authorization `state` values are random, stored only as hashes, expire after 15 minutes, and are accepted once.
- Full IBANs are never added to the normalized model or export.
- Monetary values remain exact decimal strings in SQLite.
- The Electron renderer is sandboxed and receives access only through validated IPC operations.
- Exported spreadsheet text is protected against formula injection.
- There is no telemetry and no payment API usage.

Raw provider responses are optional. They are excluded from Git but are not encrypted, so keep the application directory private or set `RETAIN_RAW_DATA=false`.

## Desktop features

The production desktop application provides:

- a manual date range from three calendar months ago through today by default;
- full, movement-and-export, export-only, and custom synchronization steps;
- automatic fallback to the longest transaction history available when a bank rejects the exact requested period;
- an automatic local HTTPS callback server and interactive bank reauthorization;
- a 94.5% interface scale and 1271 × 794 initial window;
- an extraction splash plus an animated in-app loading window;
- live progress showing every execution step, with one mutable line per step;
- account aliases and separate synchronize/export switches;
- configurable, deduplicated XLSX imports for card statements;
- ordered categorization rules with drag-and-drop;
- configurable dependent category and subcategory picklists;
- configurable export fields, order, column names, XLSX/CSV format, and CSV regional options;
- custom save/discard prompts for unsaved tab changes and safe close prompts for active operations;
- English and Spanish interfaces loaded from external translation files, with immediate switching;
- collapsible execution audit records with account snapshots and totals by currency;
- a persistent selector for the latest 5, 10, 20, 50, or 100 audit runs;
- a current-year execution counter, full audit window, and confirmed history cleanup;
- shortcuts to the latest export and confirmed deletion of generated result files;
- diagnostics, local file shortcuts, and a Windows Task Scheduler command.

The desktop interface is production-only. The CLI continues to support sandbox and production.

When an ASPSP returns `WRONG_TRANSACTIONS_PERIOD`, Kakebo Harvester retries that account with Enable Banking's `longest` strategy. Pagination continues with the same request parameters, and only movements inside the date interval selected in the application are added to SQLite and exports.

Enable Banking error responses are parsed using their HTTP status, textual
`error` code, and safe `message`. Known session, authentication, unavailable
bank, transaction-period, and rate-limit failures retain dedicated application
errors; every other provider code is preserved instead of being collapsed into
a generic validation error. Provider `detail` values are deliberately excluded
from user-facing messages and local logs.

`ASPSP_RATE_LIMIT_EXCEEDED` is not retried immediately. The affected connection
is blocked locally for at least six hours, or longer when `Retry-After` requires
it. The connection view displays the provider code and next permitted attempt,
and a repeated synchronization is rejected locally without contacting the bank.
Other HTTP 429 responses use `Retry-After` when supplied and otherwise apply a
15-minute safety interval. Reauthorization does not bypass an ASPSP rate limit.

Manual desktop synchronizations are identified as online requests by forwarding
only the real Electron User-Agent and selected application language as PSU
headers. Scheduled executions remain background requests and send no PSU
headers. The CLI behaves as background by default; add `--online` only when the
user is actively waiting for that command. If a background cooldown already
exists, `--retry-rate-limit` permits one explicit online attempt when combined
with `--online`.

Required PSU headers published by `/aspsps` are stored per connection. An online
request is rejected locally when the ASPSP requires a value Kakebo Harvester
cannot determine truthfully, such as a public IP address. The application never
invents IP, Referer, geolocation, or browser request values. PSU header values
remain in memory and are not written to raw responses, logs, or SQLite.

When a background cooldown is active, the desktop asks before making one online
attempt. A successful request clears the cooldown. A repeated
`ASPSP_RATE_LIMIT_EXCEEDED` marks that attempt as used and prevents further
online retries until the new cooldown expires.

## Export profiles

The default format for a new installation is XLSX. An upgraded installation with an existing legacy CSV keeps CSV until the user changes it. CSV settings are initialized from the Windows locale:

- comma-decimal locales default to `;` fields, `,` decimals, and `DD/MM/YYYY`;
- point-decimal locales default to `,` fields, `.` decimals, and `YYYY-MM-DD`.

The Export tab can change:

- output format: XLSX or CSV;
- enabled columns;
- column order through drag-and-drop;
- exported column names;
- CSV field separator, decimal separator, date format, and UTF-8 BOM.

Disabled export fields lose their column number and drag handle immediately but
remain in place until the profile is saved. Saving recalculates active column
numbers, keeps their relative order, and moves all disabled fields to the bottom.
Re-enabled fields rejoin the active list in their current relative order.

The same profile is used by manual runs, the CLI, and Task Scheduler. It is stored in `config/export-settings.json`.

Amount and currency are represented by one output column. CSV writes the currency
symbol together with the amount. XLSX keeps amounts numeric and applies a
per-row currency format, so mixed currencies remain usable in calculations.
Movement date and value date are real spreadsheet dates rather than text. Existing
profiles containing the former standalone `currency` field are migrated when read.

For XLSX, the first successful export after this feature is installed establishes
separate movement baselines for bank accounts and manual cards. Later bank
synchronizations apply a soft green fill (`#E6EFE9`) only to new bank movements;
card imports apply a soft amber fill (`#FAF1E2`) only to new card movements.
Each origin clears only its own previous highlights, preserving the other origin's
pending highlights. CSV output has no row-highlighting concept.

Changing the format, enabled fields, order, headers, or CSV options never overwrites a structurally incompatible result. On the next export, Kakebo Harvester moves the previous active result to `data/production/exports/archive/` and then writes the new result atomically. Normal dated backups can additionally be enabled with `EXPORT_KEEP_BACKUP=true`.

The active result is one of:

```text
data/production/exports/kakebo_movements.xlsx
data/production/exports/kakebo_movements.csv
```

The **Delete result files** action removes only Kakebo Harvester's current and archived XLSX/CSV results after an in-app confirmation. It does not remove configuration, SQLite data, raw responses, or audit history.

Tabs with edited configuration show an in-app choice to save, discard, or cancel
before navigation. Closing applies the same choice across every edited section.
When synchronization or card import is active, navigation explains that work
continues in the background; closing explains the safe-shutdown implications.

## Categorization

`config/categories.json` defines categories and their allowed subcategories. Both fields are dependent picklists in the rule editor.

`config/categorization-rules.json` supports `contains`, `equals`, `startsWith`, and `regex`. Rules are evaluated from top to bottom; their internal priority is normalized when the ordered list is saved. Existing reviewed movements are not overwritten. **Apply to history** reprocesses unreviewed movements and rebuilds the current export.

Example files are under `config/`.

## Manual card statements

The **Card imports** tab merges one or more `.xlsx` statements into the same
normalized SQLite transaction store used by bank movements. Each selected file
is explicitly included or excluded and assigned a saved profile.

A profile represents one physical card and defines:

- its stable, hidden profile id, bank, and display name;
- worksheet name, or the first worksheet when blank;
- the first data row;
- Excel column letters for date, description, optional value date, and amount;
- date layout, decimal separator, optional amount-sign inversion, and currency.

The default Kutxabank profile starts at row 9 and maps `A=fecha`,
`B=concepto`, `C=fecha valor`, and `D=importe de la operación`. Duplicate or
overlapping statements are safe to reimport. The movement key hashes the physical
card profile, normalized dates, amount, currency, description, and an occurrence
number for otherwise identical rows. Reuse the same profile for the same physical
card; changing its id creates a different card identity.

Importing selected files is atomic. Valid rows are deduplicated, categorized with
the current rules, and followed by a normal configured XLSX/CSV export. Manual
card accounts appear in the aliases table and can be excluded from exports, but
they are never sent to Enable Banking.

## Local execution audit

Every manual or scheduled synchronization creates one persistent audit run. Each run stores:

- local start and finish timestamps;
- selected steps and date interval;
- completed, running, or failed status;
- a snapshot of the selected balance for each active account;
- the provider/application error code and a safe error message when applicable.

Runs are grouped in collapsible sections. Each header shows the sum of available
account balances, separately for each currency. Both the main view and the
dedicated history window use a scrollable latest-X list; the selected limit is
stored in `config/ui-settings.json`. Failed executions show their recorded error
code and safe message. **Clear history** asks for confirmation and removes only
audit runs and their stored snapshots; exports and operational balance data
remain unchanged.

The current-year counter uses the Windows clock and timezone.

## Portable directory layout

The portable executable contains application code and runtime dependencies, but never embeds secrets, user configuration, the database, or result files.

Recommended layout:

```text
Kakebo-Harvester/
├── Kakebo-Harvester-<version>-x64.exe
├── .env.production
├── private/
│   ├── enable-banking-production.pem
│   ├── local-https-production.pfx
│   ├── local-https-production.passphrase
│   └── local-https-production-ca.thumbprint
├── config/
│   ├── accounts.json
│   ├── categorization-rules.json
│   ├── categories.json
│   ├── card-import-profiles.json
│   ├── export-settings.json
│   └── ui-settings.json
└── data/
    └── production/
        ├── kakebo-production.sqlite
        ├── raw/
        └── exports/
            └── archive/
```

`accounts.json`, `categories.json`, `card-import-profiles.json`,
`export-settings.json`, and `ui-settings.json` are created when needed. SQLite is
authoritative for account aliases and switches; `accounts.json` is a readable
snapshot.

The executable searches for `.env.production` in this order:

1. `KAKEBO_ENV_FILE`, when explicitly set;
2. next to the portable executable;
3. the Kakebo Harvester application-data directory;
4. the current working directory;
5. next to the running executable.

All relative paths in `.env.production` are resolved from the directory containing that file. Keeping the environment file next to the portable executable therefore makes the complete folder portable.

## Production setup

Requirements:

- Windows 10 or later;
- an Enable Banking production application;
- a production PEM file;
- the exact redirect URL `https://localhost:8000/callback`.

Setup:

1. Copy `.env.production.example` to `.env.production`.
2. Add the Enable Banking application ID and PEM path.
3. Generate a 32-byte base64 `SESSION_ENCRYPTION_KEY`.
4. Launch the portable executable.
5. Accept the first-run local HTTPS setup for the current Windows user.
6. Run Doctor.
7. Complete bank authorization in the external browser.
8. Run a short manual synchronization and inspect the result.

Generate the encryption key from a source checkout:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The local HTTPS certificate is separate from any code-signing certificate.
Moving to another computer does not require code changes. Kakebo Harvester checks
that the copied CA thumbprint is trusted by the current Windows user; when it is
not, startup offers to regenerate local HTTPS before opening the callback server.

For a fresh computer, copy the executable, `.env.production`, Enable Banking PEM,
and the configuration you want to retain. The application creates missing
database and output directories. For a migration with history, close the app and
scheduled task first, then copy the complete `data/production` directory together
with `.env.production`, its unchanged `SESSION_ENCRYPTION_KEY`, `private/`, and
`config/`. Run Doctor and a short synchronization after HTTPS preparation.

## Sandbox and CLI

Install dependencies and create a sandbox environment:

```powershell
npm ci
Copy-Item .env.sandbox.example .env.sandbox
```

Register `http://localhost:8000/callback` in the Enable Banking sandbox application and complete `.env.sandbox`.

Common commands:

```powershell
$env:KAKEBO_ENV_FILE = ".env.sandbox"
npm run cli -- doctor
npm run cli -- banks --country ES
npm run cli -- connect --bank "Bank name" --country ES --psu-type personal
npm run cli -- accounts
npm run cli -- initial-sync --from 2026-01-01
npm run cli -- sync-all
npm run cli -- export
```

When both `.env.sandbox` and `.env.production` exist, set `KAKEBO_ENV_FILE` explicitly for CLI commands.

## Windows Task Scheduler

The desktop Settings tab shows the exact non-interactive command:

```powershell
"C:\path\to\Kakebo-Harvester-<version>-x64.exe" --scheduled-sync
```

Configure the scheduled task to run as the same Windows user who owns the files and prepared local HTTPS.

- Success returns exit code `0`.
- Reauthorization required returns exit code `10` and never opens a browser.
- An overlapping synchronization returns exit code `11`.

The configured export profile and all account/category settings are reused automatically.

## Build the Windows portable executable

Builds should be produced on Windows x64 with Node.js 20 or later. Node.js 24 is used by the repository workflows.

From a clean checkout:

```powershell
npm ci
npm run check
npm run desktop:dist
```

Or run the combined validation and packaging command:

```powershell
npm run desktop:release
```

The portable file is created at:

```text
release/portable/Kakebo-Harvester-<version>-x64.exe
```

The release directory can also contain build intermediates:

- `release/portable/Kakebo-Harvester-<version>-x64.exe` is the single-file
  portable distribution and the only artifact uploaded to GitHub Releases;
- `release/portable/win-unpacked/` contains the same application already
  extracted. It starts faster but the whole directory must stay together and is
  intended for local diagnostics;
- `release/win-unpacked/` and `release/win-unpacked.tmp/` are intermediates from
  directory packaging or interrupted builds and should not be distributed;
- an NSIS setup executable appears only after `npm run desktop:installer`; it
  installs shortcuts and an uninstaller but is no longer a self-contained
  portable folder.

The portable target is the recommended distribution for this project. It keeps
the private runtime folder relocatable and requires no installation. Its
trade-off is extraction on every launch; the packaging splash makes that phase
visible, followed by the animated Electron loading window.

`better-sqlite3` is a native dependency. Every packaging command forcibly
rebuilds it for Electron and disables the packager's implicit native rebuild so
that a Node.js binary cannot be copied into the application by mistake. The
portable build then opens an in-memory database with the packaged module and
fails if its Electron ABI is incompatible. If CLI development or tests will
continue in the same checkout after packaging, restore the Node.js binary and
rerun validation:

```powershell
npm rebuild better-sqlite3
npm run check
```

The executable is unsigned unless a Windows code-signing certificate is configured. Windows SmartScreen may warn about unsigned community builds.

## Releases and GitHub Pages

Good practice is to validate every application change in CI but build distributable executables only for versioned tags. This avoids replacing an executable on every merge and gives users immutable versions, release notes, hashes, and rollback points.

This repository includes:

- `.github/workflows/ci.yml`: validates application changes on `main` and pull requests;
- `.github/workflows/release.yml`: builds the Windows portable executable for tags matching `v*`, generates a SHA-256 file, and uploads both to GitHub Releases;
- `.github/workflows/pages.yml`: deploys only when files under `legal/` or the Pages workflow change.

Create a release after updating `package.json`:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

GitHub Releases is the recommended home for each portable version. The Pages website links to `/releases/latest`, so it always points to the most recent published version without storing binaries in the Git repository.

## Development

```powershell
npm run desktop
npm run lint
npm run typecheck
npm test
npm run check
npm run build
```

Tests use temporary SQLite databases, fictional fixtures, and mocked HTTP calls. They never call production.

Technical implementation details are documented in [`docs/DESKTOP_APP.md`](docs/DESKTOP_APP.md).

## Known limitations

- Bank coverage, available balance types, and transaction history vary by ASPSP.
- Manual card import supports `.xlsx`, not legacy binary `.xls`.
- A bank statement without transaction ids cannot perfectly distinguish two
  physically different rows whose card, dates, amount, currency, and description
  are all identical; their stable occurrence order is used as the final key part.
- PSD2 does not guarantee mortgages, loans, investments, insurance, or every card.
- Automatic categorization is deliberately simple.
- `SESSION_ENCRYPTION_KEY` rotation is not automated.
- Local HTTPS setup is Windows-specific.
- The UI and translations currently support English and Spanish.

## Official references

- [Enable Banking Quick Start](https://enablebanking.com/docs/api/quick-start/)
- [Enable Banking API Reference](https://enablebanking.com/docs/api/reference/)
- [Enable Banking Control Panel](https://enablebanking.com/docs/api/control-panel/)
- [Restricted production and linked accounts](https://enablebanking.com/docs/api/linked-accounts/)
- [Spanish market specifics](https://enablebanking.com/docs/markets/es/)
- [Official API samples](https://github.com/enablebanking/enablebanking-api-samples)
