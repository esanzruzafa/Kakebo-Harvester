ALTER TABLE transactions ADD COLUMN card_export_enabled_snapshot INTEGER
  CHECK(card_export_enabled_snapshot IN (0, 1));
