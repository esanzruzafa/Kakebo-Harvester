CREATE TABLE cards_next (
  id TEXT PRIMARY KEY,
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id),
  alias TEXT NOT NULL,
  last4 TEXT NOT NULL CHECK(last4 GLOB '[0-9][0-9][0-9][0-9]'),
  active INTEGER NOT NULL DEFAULT 1,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  export_enabled INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  balance_text TEXT,
  balance_is_red INTEGER CHECK(balance_is_red IN (0, 1)),
  balance_read_at TEXT,
  identity_fingerprint TEXT CHECK(identity_fingerprint IS NULL OR
    (length(identity_fingerprint) = 64 AND identity_fingerprint NOT GLOB '*[^0-9a-f]*'))
);
INSERT INTO cards_next (id, bank_connection_id, alias, last4, active, sync_enabled,
  export_enabled, first_seen_at, last_seen_at, balance_text, balance_is_red, balance_read_at)
SELECT id, bank_connection_id, alias, last4, active, sync_enabled,
  export_enabled, first_seen_at, last_seen_at, balance_text, balance_is_red, balance_read_at
FROM cards ORDER BY rowid;
DROP TABLE cards;
ALTER TABLE cards_next RENAME TO cards;
CREATE UNIQUE INDEX cards_identity_fingerprint_idx ON cards(identity_fingerprint)
  WHERE identity_fingerprint IS NOT NULL;
ALTER TABLE transactions ADD COLUMN card_fingerprint_snapshot TEXT;
