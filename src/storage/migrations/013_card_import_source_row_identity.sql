ALTER TABLE card_import_source_rows ADD COLUMN source_row INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_card_import_source_rows_source_row
  ON card_import_source_rows (profile_id, source_path_hash, source_row)
  WHERE source_row IS NOT NULL;
