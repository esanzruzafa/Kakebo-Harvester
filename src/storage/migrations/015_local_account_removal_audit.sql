CREATE TABLE local_account_removal_audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action = 'local-account-removal'),
  outcome TEXT NOT NULL CHECK (outcome IN ('hidden', 'deleted')),
  occurred_at TEXT NOT NULL
);
