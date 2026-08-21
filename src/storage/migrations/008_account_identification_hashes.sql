CREATE TABLE IF NOT EXISTS account_identification_hashes (
  bank_connection_id TEXT NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  identification_hash TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (bank_connection_id, identification_hash)
);

CREATE INDEX IF NOT EXISTS account_identification_hashes_account_idx
  ON account_identification_hashes(account_id);

INSERT OR IGNORE INTO account_identification_hashes (
  bank_connection_id,
  identification_hash,
  account_id
)
SELECT bank_connection_id, identification_hash, id
FROM accounts
WHERE identification_hash IS NOT NULL
  AND identification_hash <> '';
