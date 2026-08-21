-- Migration 004 could not associate a pre-connection rate-limit audit row with
-- one bank. Clear only the deterministic backfill when several connections make
-- that association ambiguous. Later, connection-specific rate limits remain intact.
UPDATE bank_connections
SET retry_after_at = NULL,
    error_code = NULL
WHERE error_code = 'RATE_LIMIT_EXCEEDED'
  AND retry_after_at IN (
    SELECT strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      datetime(started_at, '+6 hours')
    )
    FROM desktop_runs
    WHERE status = 'FAILED'
      AND error_message_safe LIKE '%limitado temporalmente las solicitudes%'
  )
  AND (
    SELECT COUNT(*)
    FROM bank_connections
    WHERE status = 'AUTHORIZED'
      AND provider = 'enable-banking'
  ) > 1;
