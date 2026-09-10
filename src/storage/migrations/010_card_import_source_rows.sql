CREATE TABLE IF NOT EXISTS card_import_source_rows (
  profile_id TEXT NOT NULL,
  source_path_hash TEXT NOT NULL,
  semantic_key_hash TEXT NOT NULL,
  occurrence INTEGER NOT NULL CHECK (occurrence >= 1),
  provider_transaction_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, source_path_hash, semantic_key_hash, occurrence),
  UNIQUE (profile_id, source_path_hash, provider_transaction_id)
);
