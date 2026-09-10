ALTER TABLE balances
  ADD COLUMN desktop_run_id TEXT;

CREATE INDEX IF NOT EXISTS balances_desktop_run_idx
  ON balances(desktop_run_id, account_id);

CREATE TABLE IF NOT EXISTS desktop_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  error_message_safe TEXT
);

CREATE INDEX IF NOT EXISTS desktop_runs_started_idx
  ON desktop_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS desktop_run_accounts (
  run_id TEXT NOT NULL REFERENCES desktop_runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  amount TEXT,
  currency TEXT,
  balance_type TEXT,
  balance_reference_date TEXT,
  balance_extracted_at TEXT,
  PRIMARY KEY (run_id, account_id)
);

CREATE INDEX IF NOT EXISTS desktop_run_accounts_run_idx
  ON desktop_run_accounts(run_id);
