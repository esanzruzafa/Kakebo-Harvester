# Desktop application architecture

This document describes the technical boundaries, persistence model, synchronization lifecycle, export behavior, localization, packaging, and portability of the Kakebo Harvester desktop application.

## Process boundary

Electron runs two trust levels:

- the main process owns environment loading, secrets, SQLite, HTTPS, Enable Banking calls, the system browser, filesystem operations, and startup-native dialogs;
- sandboxed renderers own presentation and transient form state.

Renderers have context isolation enabled, Node.js disabled, navigation blocked, permission requests denied, and a restrictive content security policy. Preload scripts expose named operations only. Every IPC handler verifies that the sender is the expected live window and validates payloads with Zod.

The audit window has a separate preload bridge. It can list audit runs and close itself; it cannot synchronize, change configuration, open files, or delete data.

## Runtime root and configuration

The directory containing the selected `.env.production` is the runtime root. All relative environment paths are resolved from it.

The desktop application searches for `.env.production` in the explicitly configured path, portable-executable directory, application-data directory, current directory, and executable directory. This makes a complete private folder portable without compiling machine-specific paths.

Runtime configuration is divided by responsibility:

| File | Responsibility |
| --- | --- |
| `.env.production` | Environment, API identity, secret paths, database paths, retention, and operational limits |
| `config/accounts.json` | Human-readable account-settings snapshot |
| `config/categorization-rules.json` | Ordered automatic categorization rules |
| `config/categories.json` | Allowed category and dependent subcategory values |
| `config/card-import-profiles.json` | Stable physical-card identities and reusable XLSX mappings |
| `config/export-settings.json` | Output format, regional CSV settings, and ordered export columns |
| `config/ui-settings.json` | Last selected desktop language and audit history limit |
| `src/desktop/locales/en.json` | Bundled English literals |
| `src/desktop/locales/es.json` | Bundled Spanish literals |

JSON writes use a temporary file and atomic rename. Existing configuration receives a local `.backup` copy before replacement.

## Localization

The main process loads the selected translation JSON during startup and passes its dictionary to the renderer. New installations select Spanish when the Windows locale starts with `es`; all other locales select English. The choice is persisted in `ui-settings.json`.

Changing the selector writes the setting, loads the selected dictionary, retranslates static DOM nodes, and rerenders dynamic content. Restarting Electron is unnecessary. Native startup dialogs and renderer-owned confirmation modals query the same active localization store.

Translation resources are bundled application assets. The selected language is user configuration and remains outside the executable.

## UI scale and startup feedback

The main browser window uses 94.5% Chromium zoom and a 1271 × 794 initial frame.
The audit window uses the same zoom factor and a 1134 × 819 initial frame.

The portable NSIS wrapper displays `build/portable-splash.bmp` while extracting
the Electron runtime. As soon as Electron is available, a sandboxed loading
window with an animated CSS spinner remains visible while configuration, SQLite,
localization, HTTPS trust, and the callback server initialize. The main window
replaces it only after its renderer has loaded.

## Synchronization lifecycle

`SyncRunner` is the shared orchestration boundary for desktop, CLI, and scheduled execution:

1. validate the ISO date interval and selected steps;
2. acquire the cross-process synchronization lock;
3. create a `desktop_runs` audit record;
4. execute selected steps in accounts, balances, transactions, export order;
5. request interactive reauthorization only when a desktop callback is available;
6. capture one selected balance snapshot per active account;
7. mark the audit run successful or failed;
8. release the lock in all cases.

Transaction retrieval starts with the exact selected `date_from` and `date_to`. If an ASPSP rejects that interval with `WRONG_TRANSACTIONS_PERIOD`, the same account is retried with `strategy=longest`, preserving that strategy across continuation pages. Because this strategy may return a wider interval, normalized movements outside the user-selected dates are discarded before SQLite persistence and export.

Enable Banking failures are parsed as the documented `ErrorResponse` shape.
The HTTP status, textual provider code, and bounded safe message are retained;
`detail` is never displayed or persisted because it may contain provider
diagnostics not intended for end users. Session codes trigger reauthorization,
authentication codes retain the authentication exit path, `ASPSP_ERROR` and
`ASPSP_TIMEOUT` are temporary bank failures, and
`WRONG_TRANSACTIONS_PERIOD` retains its fallback behavior. All other valid
provider codes are surfaced verbatim through a typed provider error.

HTTP 429 is excluded from the short transient retry loop. For
`ASPSP_RATE_LIMIT_EXCEEDED`, the service chooses the later of the provider's
`Retry-After` value and Enable Banking's recommended six-hour background-fetch
interval. Other 429 responses choose the later of `Retry-After` and a 15-minute
safety interval. The final timestamp and provider code are stored on the
affected `bank_connections` row. Every synchronization step checks active
cooldowns before making a network request, so repeated manual or scheduled
attempts do not consume additional bank requests. A successful request or
reauthorization clears stale error state.

### Online and background PSU context

The renderer never supplies arbitrary network identity values. The trusted main
process builds the desktop PSU context from `webContents.getUserAgent()` and the
selected application language. `SyncRunner` passes that in-memory context to
account details, balances, and transaction requests only. Session, application,
ASPSP catalog, authorization, scheduled, and export-only requests do not receive
PSU headers.

`bank_connections.required_psu_headers_json` caches the normalized list
published by `/aspsps`. Existing connections refresh the catalog once before
their first online synchronization. The service verifies that every required
header is available before contacting account endpoints. If not, it raises
`PSU_HEADERS_UNAVAILABLE` instead of silently sending a partial set or
fabricating a value.

`bank_connections.online_retry_used` implements the explicit cooldown override.
The desktop can override a prior background cooldown once. If the online
request succeeds, normal connection cleanup clears both cooldown fields. If the
ASPSP returns another rate limit, the service stores a new timestamp and marks
the online attempt as used. Repeated UI actions are then rejected locally.

CLI synchronization is background by default. `--online` creates a truthful CLI
User-Agent and language context; `--retry-rate-limit` is effective only with
that online context. Task Scheduler commands intentionally omit both flags.

The progress event stream stores a single mutable entry per step. A `step-completed` event replaces its `step-started` entry, so the interface never displays duplicate running and completed lines for the same step. The interface always shows the run boundaries and every step's latest state in execution order.

Scheduled mode never opens a browser. Reauthorization and synchronization contention retain their dedicated exit codes.

## Audit persistence

Migration `003_audit_and_exports.sql` adds:

- `desktop_runs` for one record per orchestrated execution;
- `desktop_run_accounts` for account identity and balance snapshots;
- `balances.desktop_run_id` to associate new balance responses with their originating execution.

Migration `004_provider_errors.sql` adds:

- `bank_connections.retry_after_at` and its lookup index for persistent
  provider cooldowns;
- `desktop_runs.error_code` so failed manual and scheduled runs retain both the
  exact code and the safe message.

Migration `005_psu_context.sql` adds:

- `bank_connections.required_psu_headers_json` for ASPSP requirements;
- `bank_connections.online_retry_used` for the one-attempt online override.

When a run includes the balances step, the snapshot prefers balances inserted by that run. Otherwise it stores the most recently available balance. Selection uses deterministic balance-type preferences and one record per account.

Audit DTOs group snapshots under their execution and calculate one sum per
currency. Renderers use native `details` groups, expand the newest execution by
default, and constrain the list to a scrollable latest-X region. The allowed
limits are 5, 10, 20, 50, and 100; changing either window persists the shared
choice in `ui-settings.json`.

The current-year count is calculated with local start-of-year and next-start-of-year boundaries converted to UTC for the SQLite query.

Failed runs expose their error code and safe message in both audit views.
Clearing audit history deletes `desktop_run_accounts` and `desktop_runs` in one transaction. It deliberately preserves operational balances, transactions, configuration, raw data, and exports.

## Account settings

SQLite is authoritative for aliases and `sync_enabled` / `export_enabled`.

- `sync_enabled` controls new account balance and movement requests;
- `export_enabled` controls inclusion in generated files;
- disabling either setting never removes historical records.

The JSON account file is regenerated as a readable snapshot. Provider account type remains stored but is intentionally hidden from the alias table.

## Categorization dependencies and order

Categories contain a unique name and unique subcategory names. The rule editor uses the category list as its first picklist and rebuilds the subcategory picklist when the parent changes.

Rules remain compatible with the existing persisted `priority` field. The UI displays a one-based row number rather than the priority value. Drag-and-drop changes array order, and saving normalizes priorities to increments of ten. This preserves deterministic evaluation while hiding an implementation detail.

The main process rejects a saved rule whose category is unknown or whose subcategory is not a child of its selected category.

## Export architecture

`CsvExporter` retains its historical class name for CLI compatibility but now dispatches both CSV and XLSX output.

The export profile contains:

- `format`: `xlsx` or `csv`;
- CSV field separator, decimal separator, date format, and BOM option;
- an ordered list of field identifiers, editable headers, and enabled flags.

Inactive fields render without a number or drag handle. UI toggling preserves
the current row position; saving performs a stable partition with active fields
first and inactive fields last, then recalculates active column numbers. Loading
a legacy profile removes its former standalone `currency` field before validation.

A new installation defaults to XLSX. When no profile exists but a legacy active
CSV does, bootstrap preserves CSV for backward compatibility.

Field identifiers are stable internal names. Display labels and output headers are independent, so changing the application language does not silently rename an existing export schema.

For CSV:

- rows use CRLF;
- configured dates and decimal separators are applied;
- separators, quotes, and line breaks are escaped;
- optional UTF-8 BOM improves Excel compatibility.
- amount text includes the row currency symbol in the configured decimal convention.

For XLSX:

- values receive explicit string, number, boolean, or date types;
- the first row is styled and frozen;
- amount cells stay numeric and use a per-row currency-symbol format;
- movement and value dates use a spreadsheet date format;
- column widths are bounded.

## In-app confirmation and dirty-state lifecycle

The renderer stores a serialized saved snapshot for accounts, card profiles,
categorization plus dependencies, and export settings. Before leaving an edited
tab, the custom modal offers save and continue, discard and continue, or cancel.
Save calls the same validated IPC operations as the visible save buttons; discard
reloads persisted state.

The main window intercepts close and asks the renderer to resolve active work and
dirty sections. Multiple edited sections can be saved before close. Synchronization
and card import set a transient active-operation flag: navigation warns that work
continues in the background, while close explains that local work is awaited and
a pending browser authorization may be cancelled. Destructive export and audit
actions use the same renderer-owned modal instead of Windows message boxes.

The private export state stores independent movement-key baselines and pending
highlights for bank and manual-card origins. The first state-aware export
establishes both baselines without highlighting historical rows. Later bank XLSX
exports apply `#e6efe9` to newly observed Enable Banking rows, while card imports
apply `#faf1e2` to newly observed manual-card rows. Each operation clears only
the prior highlights belonging to its own origin; the other origin's pending
highlights remain in the regenerated workbook.

Spreadsheet text beginning with a formula control character is prefixed as text before either format is written.

### Profile rotation

The exporter fingerprints the complete validated profile and stores the last successfully applied fingerprint in a private state file beside the configuration.

Before writing:

1. load and validate the current profile;
2. compare it with the last applied fingerprint;
3. when different, move any active Kakebo XLSX/CSV result into `exports/archive/` with a timestamp and prior fingerprint;
4. generate a temporary result;
5. validate CSV headers or finish XLSX generation;
6. atomically rename the result;
7. persist the new applied fingerprint.

This also archives a legacy CSV the first time profile-aware export runs. A failed new export does not replace the active result.

Result cleanup enumerates only filenames generated by Kakebo Harvester and its dedicated archive directory. It never recursively deletes the configured export root.

## Manual card import

`CardImportProfilesStore` validates and atomically saves a list of physical-card
profiles. The stable profile id is intentionally not editable in the table.
Creating a profile generates a new id; the user must reuse that profile for every
overlapping statement from the same physical card.

`CardImportService` accepts at most 50 selected `.xlsx` files of at most 25 MB
each and 100,000 parsed rows each. A profile selects a worksheet, one-based start
row, Excel column letters, date interpretation, decimal separator, amount-sign
inversion, and currency. The bundled Kutxabank profile begins at row 9 with
columns A through D.

All files are parsed before SQLite changes begin. A database transaction then:

1. creates or refreshes a local `manual-card` connection and card account;
2. normalizes each row into the common transaction model;
3. hashes profile id, normalized dates, amount, currency, description, and an
   occurrence ordinal into a deterministic provider id;
4. uses the existing transaction repository for insert/update/duplicate handling;
5. applies the current categorization rules.

After commit, the desktop handler regenerates the configured export and account
settings snapshot. Local card connections are excluded explicitly from
authorization checks, Enable Banking sessions, balance calls, and transaction
requests. Their accounts remain available for aliases and export inclusion.

There is no mathematically perfect identity when a source statement omits ids
and contains two indistinguishable rows. The ordinal distinguishes such rows
while their relative occurrence order remains stable.

## Local HTTPS and reauthorization

Production starts a local Fastify HTTPS callback server. First run can generate a local CA and localhost certificate for the current Windows user. The certificate is operational TLS material, not application code signing.

Startup validates not only that the PFX and passphrase files exist, but also that
the saved CA thumbprint is present in the current user's Windows Root store.
Copying TLS files to another computer therefore triggers the preparation prompt
instead of incorrectly treating the old machine's trust as valid.

When a bank session expires during interactive synchronization, the runner pauses the current step, opens the provider HTTPS URL in the system browser, waits for the validated callback, and retries that same step. A new authorization invalidates older pending states for the connection.

Shutdown cancels pending authorization waiters, waits for active operations, closes the callback server, releases locks, and closes SQLite.

## Packaging

The build sequence is:

1. TypeScript compilation;
2. copy HTML, CSS, preload files, locale JSON, and SQL migrations;
3. forcibly rebuild `better-sqlite3` for the target Electron ABI and disable
   the packager's implicit native rebuild;
4. package with ASAR and unpack only the native SQLite binary;
5. embed the bitmap extraction splash and produce the Windows x64 portable executable;
6. open an in-memory database with the packaged native module so an ABI mismatch
   fails the build before publication.

Source maps, runtime environment files, secrets, databases, raw responses, configuration, and results are excluded from the application archive.

The release workflow validates the tag against `package.json`, runs all checks, rebuilds the native dependency, produces the portable file, generates a SHA-256 checksum, and attaches both to a GitHub Release.

## Portability checklist

Before moving computers:

1. close the UI and disable its scheduled task;
2. copy the complete private runtime folder, including SQLite sidecar files if present;
3. preserve `.env.production`, `SESSION_ENCRYPTION_KEY`, PEM, configuration, and data together;
4. launch as the target Windows user;
5. accept automatic local HTTPS preparation when the copied CA is not trusted;
6. run Doctor and a short synchronization;
7. recreate Task Scheduler with the command shown by the UI.

Losing `SESSION_ENCRYPTION_KEY` makes stored provider sessions unreadable and requires reauthorization. It does not corrupt normalized historical data.

For a fresh installation, the SQLite database, configuration files, and output
directories may be absent and are created on demand. The executable still needs
`.env.production`, the Enable Banking production application id, its PEM, and a
valid encryption key. No Node.js installation or compiler is required on the
target computer because Electron and the native SQLite binary are packaged.

The one-file portable is the release artifact. `win-unpacked` is a development
intermediate that avoids per-launch extraction but must be distributed as a
complete directory. An NSIS installer adds normal Windows installation,
shortcuts, and uninstallation at the cost of losing the single relocatable
runtime-folder model.
