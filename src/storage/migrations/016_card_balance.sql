ALTER TABLE cards ADD COLUMN balance_text TEXT;
ALTER TABLE cards ADD COLUMN balance_is_red INTEGER CHECK(balance_is_red IN (0, 1));
ALTER TABLE cards ADD COLUMN balance_read_at TEXT;
ALTER TABLE transactions ADD COLUMN card_alias_snapshot TEXT;
ALTER TABLE transactions ADD COLUMN card_last4_snapshot TEXT;
