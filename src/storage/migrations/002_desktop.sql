ALTER TABLE accounts
  ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE accounts
  ADD COLUMN export_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE pending_authorizations
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'connect';

CREATE TABLE IF NOT EXISTS application_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
