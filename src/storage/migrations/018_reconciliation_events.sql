CREATE TABLE transaction_reconciliation_events (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('confirm', 'undo')),
  kind TEXT NOT NULL CHECK(kind IN ('settlement', 'duplicate')),
  first_movement_key TEXT NOT NULL,
  second_movement_key TEXT NOT NULL,
  first_amount_snapshot TEXT NOT NULL,
  second_amount_snapshot TEXT NOT NULL,
  currency_snapshot TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  environment TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX transaction_reconciliation_events_reference_idx
  ON transaction_reconciliation_events(reference, recorded_at);
INSERT INTO transaction_reconciliation_events
  (id, reference, action, kind, first_movement_key, second_movement_key,
   first_amount_snapshot, second_amount_snapshot, currency_snapshot, confirmed_at,
   environment, recorded_at)
SELECT lower(hex(randomblob(16))), first.reference, 'confirm', first.kind,
  first.movement_key, second.movement_key, first.amount_snapshot, second.amount_snapshot,
  first.currency_snapshot, first.confirmed_at, source_row.environment, first.confirmed_at
FROM transaction_reconciliations first
JOIN transaction_reconciliations second ON second.reference = first.reference
  AND second.movement_key > first.movement_key
JOIN transactions source_row ON source_row.movement_key = first.movement_key;
