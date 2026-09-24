CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  alias TEXT NOT NULL,
  last4 TEXT NOT NULL CHECK(last4 GLOB '[0-9][0-9][0-9][0-9]'),
  active INTEGER NOT NULL DEFAULT 1,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  export_enabled INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(bank_connection_id, last4)
);

INSERT INTO cards (id, bank_connection_id, alias, last4, active, sync_enabled,
  export_enabled, first_seen_at, last_seen_at)
SELECT a.id, a.bank_connection_id, COALESCE(NULLIF(a.account_alias, ''), a.name, 'Tarjeta'),
  substr(a.product_type, -4), a.active, a.sync_enabled, a.export_enabled,
  a.first_seen_at, a.last_seen_at
FROM accounts a JOIN bank_connections c ON c.id = a.bank_connection_id
WHERE c.provider = 'kutxabank-browser' AND a.account_type = 'CARD'
  AND substr(a.product_type, -4) GLOB '[0-9][0-9][0-9][0-9]';

CREATE TEMP TABLE kakebo_reconciliations_backup AS
  SELECT * FROM transaction_reconciliations;
DROP TABLE transaction_reconciliations;
ALTER TABLE transactions RENAME TO transactions_before_cards;

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  movement_key TEXT NOT NULL UNIQUE,
  reconciliation_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  account_id TEXT NOT NULL,
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
  raw_fingerprint TEXT NOT NULL,
  fallback_occurrence INTEGER CHECK(fallback_occurrence IS NULL OR fallback_occurrence >= 1),
  counterparty_identification_hash TEXT
);
INSERT INTO transactions SELECT * FROM transactions_before_cards;
DROP TABLE transactions_before_cards;
CREATE INDEX transactions_reconciliation_idx
  ON transactions(account_id, reconciliation_key, status);

CREATE TABLE transaction_reconciliations (
  movement_key TEXT PRIMARY KEY REFERENCES transactions(movement_key) ON UPDATE CASCADE ON DELETE CASCADE,
  reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('settlement', 'duplicate')),
  representative INTEGER NOT NULL CHECK(representative IN (0, 1)),
  amount_snapshot TEXT NOT NULL,
  currency_snapshot TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);
INSERT INTO transaction_reconciliations SELECT * FROM kakebo_reconciliations_backup;
DROP TABLE kakebo_reconciliations_backup;
CREATE INDEX transaction_reconciliations_reference_idx ON transaction_reconciliations(reference);

UPDATE sync_runs SET account_id = NULL WHERE account_id IN (SELECT id FROM cards);
DELETE FROM accounts WHERE id IN (SELECT id FROM cards);
