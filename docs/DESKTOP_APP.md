# Desktop application architecture

This document describes the technical boundaries, persistence model, synchronization lifecycle, export behavior, localization, packaging, and portability of the Kakebo Harvester desktop application.

## Process boundary

Electron runs two trust levels:

- the main process owns environment loading, secrets, SQLite, HTTPS, Enable Banking calls, the system browser, filesystem operations, and native dialogs;
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
| `config/export-settings.json` | Output format, regional CSV settings, and ordered export columns |
| `config/ui-settings.json` | Last selected desktop language |
| `src/desktop/locales/en.json` | Bundled English literals |
| `src/desktop/locales/es.json` | Bundled Spanish literals |

JSON writes use a temporary file and atomic rename. Existing configuration receives a local `.backup` copy before replacement.

## Localization

The main process loads the selected translation JSON during startup and passes its dictionary to the renderer. New installations select Spanish when the Windows locale starts with `es`; all other locales select English. The choice is persisted in `ui-settings.json`.

Changing the selector writes the setting, loads the selected dictionary, retranslates static DOM nodes, and rerenders dynamic content. Restarting Electron is unnecessary. Native dialogs query the same active localization store.

Translation resources are bundled application assets. The selected language is user configuration and remains outside the executable.

## UI scale

The main browser window uses 75% Chromium zoom and a 960 × 630 initial frame. This preserves the original effective layout space while reducing the physical size of text, controls, content, and window. The audit window uses the same zoom factor.

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

The progress event stream stores a single mutable entry per step. A `step-completed` event replaces its `step-started` entry, so the interface never displays duplicate running and completed lines for the same step. The collapsed view keeps the run start plus the current or terminal event. The expanded view shows every step's latest state and the run boundaries.

Scheduled mode never opens a browser. Reauthorization and synchronization contention retain their dedicated exit codes.

## Audit persistence

Migration `003_audit_and_exports.sql` adds:

- `desktop_runs` for one record per orchestrated execution;
- `desktop_run_accounts` for account identity and balance snapshots;
- `balances.desktop_run_id` to associate new balance responses with their originating execution.

When a run includes the balances step, the snapshot prefers balances inserted by that run. Otherwise it stores the most recently available balance. Selection uses deterministic balance-type preferences and one record per account.

The current-year count is calculated with local start-of-year and next-start-of-year boundaries converted to UTC for the SQLite query.

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

A new installation defaults to XLSX. When no profile exists but a legacy active
CSV does, bootstrap preserves CSV for backward compatibility.

Field identifiers are stable internal names. Display labels and output headers are independent, so changing the application language does not silently rename an existing export schema.

For CSV:

- rows use CRLF;
- configured dates and decimal separators are applied;
- separators, quotes, and line breaks are escaped;
- optional UTF-8 BOM improves Excel compatibility.

For XLSX:

- values receive explicit string, number, or boolean types;
- the first row is styled and frozen;
- amount cells use a two-decimal numeric format;
- column widths are bounded.

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

## Local HTTPS and reauthorization

Production starts a local Fastify HTTPS callback server. First run can generate a local CA and localhost certificate for the current Windows user. The certificate is operational TLS material, not application code signing.

When a bank session expires during interactive synchronization, the runner pauses the current step, opens the provider HTTPS URL in the system browser, waits for the validated callback, and retries that same step. A new authorization invalidates older pending states for the connection.

Shutdown cancels pending authorization waiters, waits for active operations, closes the callback server, releases locks, and closes SQLite.

## Packaging

The build sequence is:

1. TypeScript compilation;
2. copy HTML, CSS, preload files, locale JSON, and SQL migrations;
3. rebuild `better-sqlite3` for the target Electron ABI;
4. package with ASAR and unpack only the native SQLite binary;
5. produce the Windows x64 portable executable.

Source maps, runtime environment files, secrets, databases, raw responses, configuration, and results are excluded from the application archive.

The release workflow validates the tag against `package.json`, runs all checks, rebuilds the native dependency, produces the portable file, generates a SHA-256 checksum, and attaches both to a GitHub Release.

## Portability checklist

Before moving computers:

1. close the UI and disable its scheduled task;
2. copy the complete private runtime folder, including live SQLite WAL files if present;
3. preserve `.env.production`, `SESSION_ENCRYPTION_KEY`, PEM, configuration, and data together;
4. launch as the target Windows user;
5. regenerate local HTTPS;
6. run Doctor and a short synchronization;
7. recreate Task Scheduler with the command shown by the UI.

Losing `SESSION_ENCRYPTION_KEY` makes stored provider sessions unreadable and requires reauthorization. It does not corrupt normalized historical data.
