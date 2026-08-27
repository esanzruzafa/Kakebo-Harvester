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
- an in-app assistant to discover and connect an additional bank without using the CLI;
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

## Connect a new bank from the desktop application

Open **Accounts and aliases** and select **Connect a new bank**. The assistant
starts with the configured country, lets you choose another supported country,
loads the current Enable Banking bank catalog, filters it locally, and offers
only the customer types published for the selected bank.

After selecting the bank and customer type, **Continue to the bank** opens the
provider's HTTPS authorization URL in the default browser. Enter credentials,
PINs, OTPs, or any other authentication information only in that official flow.
The desktop waits for the validated local HTTPS callback. On success it writes
the provider session and discovered accounts, updates `config/accounts.json`,
and refreshes the accounts and connection views without restarting the app.

The assistant is unavailable while a synchronization is running and requires
the local HTTPS callback to be ready. If aliases or account switches have
unsaved edits, it asks whether to save or discard them before starting so a
completed connection cannot overwrite local form changes. Listing banks and
connecting through the UI use the same API flow as `banks` and `connect` in the
CLI.

## Revoke a bank consent

Each non-revoked connection in the synchronization view has a **Revoke consent**
action next to the access renewal action. After an in-app confirmation, Kakebo
Harvester attempts to delete the remote Enable Banking session, removes every
local provider session, deactivates the related accounts, and marks the
connection as revoked. Revoked connections disappear from the connection list.
It does not delete historical movements, exports, raw responses, or audit
records.

Network or provider failures can prevent confirmation of the remote revocation.
In that case the local disconnect still completes and the application clearly
asks you to revoke the consent from the bank or Enable Banking control panel as
well.

When an ASPSP returns `WRONG_TRANSACTIONS_PERIOD`, Kakebo Harvester retries that account with Enable Banking's `longest` strategy. Pagination continues with the same request parameters, and only movements inside the date interval selected in the application are added to SQLite and exports.

`ASPSP_ERROR` means the bank temporarily failed while Enable Banking was retrieving
account information. It does not require revocation or reauthorization. Retry the
operation after at least one minute; if it persists, use wider intervals of one,
two, and four hours, then review the request log in the Enable Banking control
panel.

When an enabled account returns a recoverable bank-side error, the desktop app
identifies the affected account in progress, records its latest error in the
Accounts view, and asks whether to continue. Continuing skips that account for
the remaining account, balance, and transaction steps of that execution; the
next execution tries it again unless it is disabled.

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

The **Reset local data** action permanently removes Kakebo Harvester's current and archived XLSX/CSV results, imported bank and card movements, balances, raw provider responses, and execution history after an in-app confirmation. It preserves bank connections and sessions, account preferences, and every configuration file. The database reset is atomic; result and raw-file cleanup is reported separately so a Windows file lock cannot hide that the financial history was already cleared. If a locked file remains, the application refreshes its empty history, shows a warning, and lets you retry after closing the program that holds the file. The next synchronization therefore starts with empty local financial history without requiring bank reconnection.

For deletion safety, `DATABASE_PATH`, `RAW_DATA_DIRECTORY`, and `EXPORT_DIRECTORY` must use one environment folder: the SQLite file and the distinct `raw` and `exports` directories are siblings. Startup rejects broader or nested layouts before any cleanup can run.

Tabs with edited configuration show an in-app choice to save, discard, or cancel
before navigation. Closing applies the same choice across every edited section.
When synchronization or card import is active, navigation explains that work
continues in the background; closing explains the safe-shutdown implications.

## Categorization

`config/categories.json` defines categories and their allowed subcategories. Both fields are dependent picklists in the rule editor.

`config/categorization-rules.json` contains two ordered lists: `exclusions` and `rules`. Both support `contains`, `equals`, `startsWith`, and `regex`; exclusions are always evaluated first, so matching movements remain uncategorized. The Categorization tab provides separate drag-and-drop editors for both lists. Rules are evaluated from top to bottom; their internal priority is normalized when the ordered list is saved. Existing reviewed movements are not overwritten. **Apply to history** reprocesses unreviewed movements and rebuilds the current export.

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

Kakebo Harvester also stores a hashed source-row identity for each imported file.
When an existing workbook is updated in place, even a single prior movement is
recognized without treating one coincidental movement from a different statement
as overlap. The **Reset local data** action clears this operational identity
together with the imported movements.

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
├── private/
│   ├── .env.production
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

The executable searches for `private/.env.production` in this order:

1. `KAKEBO_ENV_FILE`, when explicitly set;
2. next to the portable executable;
3. the Kakebo Harvester application-data directory;
4. the current working directory;
5. next to the running executable.

The legacy root-level `.env.production` locations remain supported for existing installations, but `private/.env.production` takes precedence. All relative paths are resolved from the directory containing the selected file. The production template is already written for the recommended `private/` location: secrets use paths inside `private/`, while data and configuration use `../data/...` and `../config/...`.

## Production setup

Requirements:

- Windows 10 or later;
- an Enable Banking production application;
- a production PEM file;
- the exact redirect URL `https://localhost:8000/callback`.

Setup:

1. Copy `private/.env.production.example` to `private/.env.production`.
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

For a fresh computer, copy the executable, the complete `private/` directory,
and the configuration you want to retain. The application creates missing
database and output directories. For a migration with history, close the app and
scheduled task first, then copy the complete `data/production` directory together
with `private/.env.production`, its unchanged `SESSION_ENCRYPTION_KEY`, the rest
of `private/`, and `config/`. Run Doctor and a short synchronization after HTTPS
preparation.

## Sandbox and CLI

Install dependencies and create a sandbox environment:

```powershell
npm ci
Copy-Item private/.env.sandbox.example private/.env.sandbox
```

Register `http://localhost:8000/callback` in the Enable Banking sandbox application and complete `private/.env.sandbox`.

Common commands:

```powershell
$env:KAKEBO_ENV_FILE = "private/.env.sandbox"
npm run cli -- doctor
npm run cli -- banks --country ES
npm run cli -- connect --bank "Bank name" --country ES --psu-type personal
npm run cli -- accounts
npm run cli -- initial-sync --from 2026-01-01
npm run cli -- sync-all
npm run cli -- export
```

When both `private/.env.sandbox` and `private/.env.production` exist, set `KAKEBO_ENV_FILE` explicitly for CLI commands.

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

Builds should be produced on Windows x64 with Node.js 22.19 or later. Node.js 24 is used by the repository workflows.

From a clean checkout:

```powershell
npm ci
npm run audit:all
npm run check
npm run build
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
applies every packaged SQL migration to a temporary database. It fails if the
Electron ABI is incompatible, a migration is missing, or the packaged schema
cannot reach its latest version. Regular pull-request validation also builds the
application and checks that all runtime assets and migrations were copied. If
It also verifies the packaged entry point, splash image, and extra resources
declared in `package.json`. If CLI development or tests will continue in the
same checkout after packaging, restore the Node.js binary and rerun validation:

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
git tag v1.0.0
git push origin v1.0.0
```

GitHub Releases is the recommended home for each portable version. The Pages website links to `/releases/latest`, so it always points to the most recent published version without storing binaries in the Git repository.

## Dependency updates

Dependabot is configured in `.github/dependabot.yml`. It is a GitHub service, not a GitHub Actions job: GitHub reads that file and creates dependency pull requests automatically.

- Root npm dependencies are checked weekly on Monday at 06:00 Europe/Madrid.
- The legal site's npm dependencies are checked weekly at 06:15 Europe/Madrid.
- GitHub Actions are checked weekly at 06:30 Europe/Madrid.
- npm minor and patch updates are grouped by package directory to reduce pull-request noise. Major npm updates and every GitHub Actions update remain separate for review.
- Dependency and workflow configuration pull requests trigger the application and legal validation jobs in CI.

Dependabot alerts, security update PRs, grouped security updates, and Dependabot on Actions are repository Security settings managed in GitHub. They are not enabled by this file. Keep alerts and security updates enabled in the GitHub repository settings; security fixes can arrive outside the weekly version-update schedule.

### Dependabot auto-merge policy

`.github/workflows/dependabot-auto-merge.yml` enables GitHub's native auto-merge only when all of the following conditions are true:

- the pull request was created by `dependabot[bot]` in this repository and targets `main`;
- it updates the `npm` ecosystem;
- it changes an indirect dependency only; and
- it is a SemVer patch or minor update.

Major updates, direct production and development dependencies, and every GitHub Actions update remain manual. Native auto-merge waits for the branch's required checks before merging and uses squash commits. The workflow pins Dependabot's metadata action and matches the exact reviewed head SHA before enabling auto-merge.

Before enabling this workflow on GitHub, configure branch protection as follows:

1. Enable the `main` ruleset and require the `check` and `legal` status checks.
2. Enable **Allow auto-merge** in the repository's Pull Requests settings.
3. Allow squash merges only, if a linear main history is desired.
4. Do not enable Merge Queue unless CI is extended with the `merge_group` trigger and the auto-merge workflow is authenticated with a token that can add pull requests to that queue.

Avoid global branch rules that restrict ordinary branch creation or updates: Dependabot needs to create and update its own branches. Repository write access remains the appropriate control for who may push branches. Public repositories cannot prevent third parties from proposing pull requests from their forks, but they cannot merge or push to this repository without the permissions and protections above.

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

## License

Kakebo Harvester is open-source software licensed under the [MIT License](LICENSE).
Copyright © 2026 Eduardo Sanz.

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
