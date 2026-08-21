ALTER TABLE transactions ADD COLUMN fallback_occurrence INTEGER
  CHECK (fallback_occurrence IS NULL OR fallback_occurrence >= 1);
