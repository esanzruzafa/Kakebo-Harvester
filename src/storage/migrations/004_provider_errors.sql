ALTER TABLE bank_connections
  ADD COLUMN retry_after_at TEXT;

CREATE INDEX IF NOT EXISTS bank_connections_retry_after_idx
  ON bank_connections(retry_after_at);

ALTER TABLE desktop_runs
  ADD COLUMN error_code TEXT;

UPDATE bank_connections
SET retry_after_at = (
      SELECT strftime(
        '%Y-%m-%dT%H:%M:%fZ',
        datetime(MAX(started_at), '+6 hours')
      )
      FROM desktop_runs
      WHERE status = 'FAILED'
        AND error_message_safe LIKE '%limitado temporalmente las solicitudes%'
    ),
    error_code = COALESCE(error_code, 'RATE_LIMIT_EXCEEDED')
WHERE status = 'AUTHORIZED'
  AND EXISTS (
    SELECT 1
    FROM desktop_runs
    WHERE status = 'FAILED'
      AND error_message_safe LIKE '%limitado temporalmente las solicitudes%'
  );
