CREATE TABLE transaction_reconciliations (
  movement_key TEXT PRIMARY KEY REFERENCES transactions(movement_key) ON UPDATE CASCADE ON DELETE CASCADE,
  reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('settlement', 'duplicate')),
  representative INTEGER NOT NULL CHECK(representative IN (0, 1)),
  amount_snapshot TEXT NOT NULL,
  currency_snapshot TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);
CREATE INDEX transaction_reconciliations_reference_idx ON transaction_reconciliations(reference);
