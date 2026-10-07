# Dependabot consolidation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current worktree.

**Goal:** Apply all viable open Dependabot updates together and close superseded PRs after verified integration.

**Architecture:** Combine independent manifest, lockfile and pinned workflow updates on current main. Investigate major-version failures individually and retain any upstream-blocked PR with concrete evidence.

**Tech Stack:** Node 24, Electron, better-sqlite3, TypeScript, ESLint, Vitest, Next.js, GitHub Actions.

**Spec:** User goal in this chat: apply possible improvements, minimize releases, resolve all Dependabot PRs except justified exclusions.

## Global constraints

- Preserve read-only local banking behavior and existing application version; no release tag required for dependency integration.
- Preserve strict lint and TypeScript checks; no forced peer dependency installation.
- Work only on Dependabot changes; leave PRs 29 and 30 alone.
- Publish and close PRs only after validation; verify CI against the final head.

## Review focus

- Native SQLite functions, migrations and packaged loading must work with SQLite 13 and Electron 44.
- Clipboard IPC must wait for asynchronous writes and propagate failures.
- Node declaration updates must remain compatible with logger dependency declarations.
- TypeScript tooling peer compatibility must hold during clean npm installation.
- Legal site and all pinned setup-node workflow references must build together.

### Task 1: Consolidate compatible updates

- [x] Apply PR 54 root manifest and lockfile, PR 53 legal manifest and lockfile, and PR 39 workflow pins.
- [x] Add SQLite 13.0.3 and Electron 44.6.0, updating install-script approvals to match.
- [x] Install cleanly; reproduce Electron lint failure before fixing clipboard IPC.
- [x] Await clipboard write in its async handler, using existing IPC rejection behavior.
- [x] Run lint, typecheck, full tests, audits, legal typecheck/build and portable package verification.

### Task 2: Evaluate blocked toolchain upgrades

- [x] Verify current TypeScript ESLint peer ranges and thread-stream declarations.
- [x] Apply Node 26 types only if dependency compatibility is restored without weakening checks.
- [x] Keep TypeScript 7 deferred if the official linter still rejects it; record exact evidence.

Evidence: typescript-eslint 8.71.0 requires TypeScript >=4.8.4 <6.1.0. thread-stream 4.2.0 still uses worker_threads.TransferListItem; upstream issue 228 and fix PR 233 remain open. PRs 34 and 35 stay pending until supported upstream releases.

Task 1 ruling: SQLite 13 uses shipped N-API prebuilds. Remove legacy Electron-specific rebuilding and explicitly unpack the Windows x64 prebuild; packaged smoke/migrations are the behavioral gate. The legacy rebuild failed downloading headers due to the local certificate chain.

Local validation: npm run check passed (63 files, 434 passed, 2 skipped); legal typecheck/build passed; root audit:all passed its high-severity gate with 8 moderate packaging-tool advisories; legal production audit passed with zero vulnerabilities. Manifest/lockfile consistency and git diff --check passed.

Independent review: no critical or important findings. Minor deferred: SQLite 13 has no install script, so its existing allowScripts approval is redundant but harmless.

Portable validation: desktop:dist passed, generating EXE and complete ZIP. Packaged SQLite ABI and all migrations passed (v19). Packaging tests passed (3 ZIP tests plus 4 workflow/assets tests); one earlier ZIP test hit its 15s timeout during simultaneous heavy builds, then passed unchanged in an isolated run. Official setup-node v7.0.0 tag resolves to the pinned 820762786026740c76f36085b0efc47a31fe5020 commit.

### Task 3: Integrate and resolve PR backlog

- [ ] Review full diff and publish one consolidated PR with validation and disposition of all seven PRs.
- [ ] Wait for fresh CI and check review threads and mergeability.
- [ ] Integrate authorized updates and close superseded Dependabot PRs with links to the consolidated change.
- [ ] Verify remaining Dependabot PRs and report justified exclusions.
