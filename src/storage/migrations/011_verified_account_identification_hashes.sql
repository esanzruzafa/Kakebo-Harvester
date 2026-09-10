ALTER TABLE account_identification_hashes
ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));

UPDATE account_identification_hashes
SET verified = 1
WHERE EXISTS (
  SELECT 1
  FROM accounts
  WHERE accounts.id = account_identification_hashes.account_id
    AND accounts.bank_connection_id = account_identification_hashes.bank_connection_id
    AND accounts.identification_hash = account_identification_hashes.identification_hash
);
