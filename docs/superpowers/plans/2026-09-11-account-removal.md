# Account Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver issue #25's safe hide and destructive local account removal flows.

**Architecture:** Add an account-removal domain operation around the existing SQLite repository and synchronization lock. Expose only validated trusted-window IPC, then layer the app-styled renderer modal and refresh logic above it.

**Tech Stack:** TypeScript, better-sqlite3, Electron IPC/preload, Vitest, existing locale dictionaries.

**Spec:** `docs/superpowers/specs/2026-09-11-account-removal-design.md`

## Global Constraints

- The feature is local-only: never call Enable Banking, revoke consent, close remote accounts, or delete a bank connection/session.
- Scope database and file actions to the active environment and selected account.
- Raw cleanup is direct-file-only, confined to `rawDataDirectory`, and rejects symbolic links/junctions, shared paths, and ambiguity.
- Use the existing renderer-owned modal; no native Windows confirmation dialog.
- IPC must be schema-validated and restricted to the trusted application window.
- UI copy must be English and Spanish and keyboard accessible.
- Keep audit data free of account identifiers and financial data.

---

### Task 1: Account-removal persistence operation

**Files:**
- Create: `src/storage/account-removal.ts`
- Modify: `src/storage/repositories/account-repository.ts`
- Modify: `src/storage/migrations/` as required for hidden-state/audit storage
- Test: `tests/unit/account-removal.test.ts`

**Interfaces:**
- Produces `removeLocalAccount(input): Promise<AccountRemovalResult>` where `mode` is `keep-history` or `delete-history`.
- Produces repository methods to hide, rediscover, and transactionally purge exactly one account.

- [ ] **Step 1: Write failing persistence tests**

Cover hidden account preservation and rediscovery, destructive deletion of only selected-account tables, sibling account preservation, environment isolation, and rollback when a constrained delete fails.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/unit/account-removal.test.ts`

- [ ] **Step 3: Implement minimal repository and service support**

Use an SQLite transaction for account-scoped rows. Mark a retained-history account hidden and disabled; clear that state from provider reconciliation/upsert. Return only safe counts and status.

- [ ] **Step 4: Run focused persistence tests**

Run: `npm test -- tests/unit/account-removal.test.ts tests/unit/account-repository.test.ts`

- [ ] **Step 5: Commit**

Commit message: `feat(accounts): add local account removal persistence`

### Task 2: Safe raw cleanup, export and private audit follow-ups

**Files:**
- Modify: `src/storage/account-removal.ts`
- Modify: `src/desktop/committed-operations.ts`
- Test: `tests/unit/account-removal.test.ts`
- Test: `tests/unit/committed-operations.test.ts`

**Interfaces:**
- Consumes Task 1's `AccountRemovalResult`.
- Produces a result with safe follow-up warnings and no sensitive audit payload.

- [ ] **Step 1: Write failing file-scope and follow-up tests**

Exercise direct owned raw removal, shared/outside/symlink rejection, export regeneration after destructive removal, snapshot rollback, and an audit event without selected-account or financial fields.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npm test -- tests/unit/account-removal.test.ts tests/unit/committed-operations.test.ts`

- [ ] **Step 3: Implement constrained cleanup and follow-ups**

Use `lstat` and resolved-path containment before removing one eligible file. Reuse the established warning model for export/snapshot follow-ups.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/unit/account-removal.test.ts tests/unit/committed-operations.test.ts`

- [ ] **Step 5: Commit**

Commit message: `feat(accounts): safely purge selected account history`

### Task 3: Trusted desktop contract and operation coordination

**Files:**
- Modify: `src/desktop/contracts.ts`
- Modify: `src/desktop/preload.cjs`
- Modify: `src/desktop/main.ts`
- Create: `src/desktop/account-removal-request.ts`
- Test: `tests/unit/account-removal-request.test.ts`

**Interfaces:**
- Consumes `window.kakebo.removeAccount({ id, mode })`.
- Produces refreshed account state and safe operation warnings.

- [ ] **Step 1: Write failing IPC tests**

Assert invalid modes/ids and untrusted senders are rejected, active synchronization/card import/export operations block removal, and successful removal refreshes audit state and the accounts snapshot.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/unit/account-removal-request.test.ts`

- [ ] **Step 3: Implement validated IPC and locking**

Add a Zod schema, trusted-sender guard, `trackOperation`, `withSynchronizationLock`, and no remote client use.

- [ ] **Step 4: Run focused IPC tests**

Run: `npm test -- tests/unit/account-removal-request.test.ts tests/unit/account-removal.test.ts`

- [ ] **Step 5: Commit**

Commit message: `feat(desktop): expose guarded account removal`

### Task 4: Accessible confirmation UI and localization

**Files:**
- Modify: `src/desktop/renderer.ts`
- Modify: `src/desktop/locales/en.json`
- Modify: `src/desktop/locales/es.json`
- Create: `src/desktop/account-removal-dialog.ts`
- Test: `tests/unit/account-removal-dialog.test.ts`

**Interfaces:**
- Consumes the Task 3 preload contract.
- Produces a modal with retain-history default, destructive option, Cancel, safe account identity, and refreshed view state.

- [ ] **Step 1: Write failing renderer tests**

Verify the action exposes all account identity fields in masked form, starts on retain-history, requires a separate destructive selection, has keyboard reachable controls, and displays both locale keys.

- [ ] **Step 2: Run the focused UI test to verify it fails**

Run: `npm test -- tests/unit/account-removal-dialog.test.ts`

- [ ] **Step 3: Implement the renderer modal and translations**

Reuse the existing `confirmInApp` modal infrastructure; avoid Electron `dialog` and native prompts.

- [ ] **Step 4: Run focused UI tests**

Run: `npm test -- tests/unit/account-removal-dialog.test.ts`

- [ ] **Step 5: Commit**

Commit message: `feat(accounts): add accessible account removal dialog`

### Task 5: Documentation, regression verification and final review

**Files:**
- Modify: `README.md`
- Modify: `docs/DESKTOP_APP.md`
- Test: all relevant unit tests

- [ ] **Step 1: Document local-only account removal semantics**

Explain both paths, what remains untouched, rediscovery, and raw/export warning behavior.

- [ ] **Step 2: Run full verification**

Run: `npm run check` and `npm run audit:production`.

- [ ] **Step 3: Review the branch diff and commit documentation**

Run: `git diff --check origin/main...HEAD`; commit message: `docs: describe local account removal`.
