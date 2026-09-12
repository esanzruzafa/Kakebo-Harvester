# Account removal design

## Goal

Implement issue #25: let a user remove one account from the local Accounts and aliases view without ever closing a remote account, revoking consent, deleting a bank connection, or touching another local environment.

## Decisions

The safe operation records a local hidden state for the selected account and disables future synchronization and export selection. It keeps all collected records. A normal provider account discovery clears this local hidden state so the account can be shown again without a bespoke restore operation.

The destructive operation is account-scoped. It deletes the account row and the SQLite rows that reference it in one transaction, including balances, normalized movements, raw transaction metadata, account synchronization runs, account identification hashes, and audit snapshots. It never deletes a `desktop_runs` parent that can describe other accounts. Its raw-file cleanup runs after the database transaction and removes only a normalized raw-response file that is demonstrably owned by the removed account and contained directly below the configured raw-data root; shared, missing, linked, outside-root, and ambiguous paths are retained and reported as warnings.

The operation is exposed through a narrow validated IPC request from the trusted main window. It acquires the existing `SynchronizationLock`, rejects while a synchronization or tracked account operation is active, persists the readable account snapshot after a successful database change, regenerates the current export after a destructive purge, and refreshes the renderer bootstrap state plus the audit window. Follow-up snapshot/export failures are surfaced as safe warnings; database rollback applies if the account snapshot cannot be persisted.

The renderer adds one per-account action opening the existing app-styled confirmation modal. It identifies bank, connection alias, display name/alias, and masked identifier; defaults to retaining history; requires an explicit destructive choice; provides Cancel; and carries English and Spanish text plus accessible labels and keyboard controls.

## Security and privacy boundaries

- Every repository query receives the selected local account id and is constrained by the active database only.
- The implementation makes no Enable Banking request and does not mutate `bank_connections`.
- Audit logging stores only a fixed action name, outcome, and timestamp; it must not contain an account id, identifier, balance, movement, raw path, or financial field.
- IPC input is schema-validated and every handler calls `assertTrustedSender`.
- Filesystem removal refuses symlinks/junctions and path traversal, and never recursively cleans a directory for this feature.

## Validation

Repository tests cover history preservation, destructive purge, sibling accounts, environment isolation, rediscovery, transaction rollback, raw-file scope, private audit data, renderer IPC/UI accessibility, and operation locking. The branch also runs lint, typecheck, the complete Vitest suite, production dependency audit, and a final independent code review.
