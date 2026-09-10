PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bank_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  bank_country TEXT NOT NULL,
  psu_type TEXT NOT NULL,
  alias TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_authorized_at TEXT,
  valid_until TEXT,
  last_sync_at TEXT,
  reauthorization_required INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message_safe TEXT
);

CREATE TABLE IF NOT EXISTS provider_sessions (
  id TEXT PRIMARY KEY,
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  provider_session_id_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL,
  raw_response_path TEXT
);

CREATE TABLE IF NOT EXISTS pending_authorizations (
  state_hash TEXT PRIMARY KEY,
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  bank_name TEXT NOT NULL,
  redirect_url TEXT NOT NULL,
  environment TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  provider_account_id TEXT NOT NULL,
  identification_hash TEXT,
  iban_masked TEXT,
  currency TEXT,
  name TEXT,
  display_name TEXT,
  account_alias TEXT,
  account_type TEXT,
  product_type TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_response_path TEXT,
  UNIQUE(bank_connection_id, provider_account_id)
);

CREATE INDEX IF NOT EXISTS accounts_identification_hash_idx
  ON accounts(bank_connection_id, identification_hash);

CREATE TABLE IF NOT EXISTS balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  balance_type TEXT,
  name TEXT,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  reference_date TEXT,
  extracted_at TEXT NOT NULL,
  raw_response_path TEXT
);

CREATE TABLE IF NOT EXISTS transactions_raw (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  fetched_at TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  raw_response_path TEXT,
  raw_fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  movement_key TEXT NOT NULL UNIQUE,
  reconciliation_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider_transaction_id TEXT,
  entry_reference TEXT,
  status TEXT NOT NULL,
  booking_date TEXT,
  value_date TEXT,
  transaction_datetime TEXT,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL,
  description_raw TEXT,
  description_normalized TEXT,
  merchant_name TEXT,
  creditor_name TEXT,
  debtor_name TEXT,
  counterparty_iban_masked TEXT,
  bank_transaction_code TEXT,
  merchant_category_code TEXT,
  balance_after TEXT,
  category_auto TEXT,
  subcategory_auto TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  source_raw_file TEXT,
  raw_fingerprint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_reconciliation_idx
  ON transactions(account_id, reconciliation_key, status);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  bank_connection_id TEXT REFERENCES bank_connections(id),
  account_id TEXT REFERENCES accounts(id),
  date_from TEXT,
  date_to TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  pending_reconciled INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message_safe TEXT
);
