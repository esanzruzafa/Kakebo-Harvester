ALTER TABLE accounts
  ADD COLUMN last_error_at TEXT;

ALTER TABLE accounts
  ADD COLUMN last_error_code TEXT;

ALTER TABLE accounts
  ADD COLUMN last_error_message_safe TEXT;
