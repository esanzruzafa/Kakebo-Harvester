ALTER TABLE bank_connections
  ADD COLUMN required_psu_headers_json TEXT;

ALTER TABLE bank_connections
  ADD COLUMN online_retry_used INTEGER NOT NULL DEFAULT 0;
