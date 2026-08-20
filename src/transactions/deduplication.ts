import type { SqliteDatabase } from "../storage/database.js";
import { createId } from "../utils/crypto.js";
import type { NormalizedTransaction } from "./transaction-mapper.js";

export type UpsertOutcome = "inserted" | "updated" | "duplicate" | "reconciled";

const updateSql = `
  UPDATE transactions SET
    movement_key = @movement_key,
    reconciliation_key = @reconciliation_key,
    provider_transaction_id = @provider_transaction_id,
    entry_reference = @entry_reference,
    status = @status,
    booking_date = @booking_date,
    value_date = @value_date,
    transaction_datetime = @transaction_datetime,
    amount = @amount,
    currency = @currency,
    direction = @direction,
    description_raw = @description_raw,
    description_normalized = @description_normalized,
    merchant_name = @merchant_name,
    creditor_name = @creditor_name,
    debtor_name = @debtor_name,
    counterparty_iban_masked = @counterparty_iban_masked,
    bank_transaction_code = @bank_transaction_code,
    merchant_category_code = @merchant_category_code,
    balance_after = @balance_after,
    category_auto = CASE WHEN reviewed = 1 THEN category_auto ELSE @category_auto END,
    subcategory_auto = CASE WHEN reviewed = 1 THEN subcategory_auto ELSE @subcategory_auto END,
    last_seen_at = @last_seen_at,
    imported_at = @imported_at,
    source_raw_file = @source_raw_file,
    raw_fingerprint = @raw_fingerprint
  WHERE id = @id`;

export class TransactionRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public upsert(transaction: NormalizedTransaction): UpsertOutcome {
    const now = new Date().toISOString();
    const existing = this.database
      .prepare("SELECT id, raw_fingerprint FROM transactions WHERE movement_key = ?")
      .get(transaction.movement_key) as
      | { id: string; raw_fingerprint: string }
      | undefined;

    if (existing) {
      if (existing.raw_fingerprint === transaction.raw_fingerprint) {
        this.database
          .prepare("UPDATE transactions SET last_seen_at = ? WHERE id = ?")
          .run(now, existing.id);
        return "duplicate";
      }
      this.database.prepare(updateSql).run({
        ...transaction,
        id: existing.id,
        last_seen_at: now,
        imported_at: now
      });
      return "updated";
    }

    if (transaction.status === "booked") {
      const pending = this.database
        .prepare(
          `SELECT id FROM transactions
           WHERE account_id = ? AND reconciliation_key = ? AND status = 'pending'
           ORDER BY first_seen_at DESC LIMIT 1`
        )
        .get(transaction.account_id, transaction.reconciliation_key) as { id: string } | undefined;
      if (pending) {
        this.database.prepare(updateSql).run({
          ...transaction,
          id: pending.id,
          last_seen_at: now,
          imported_at: now
        });
        return "reconciled";
      }
    }

    this.database
      .prepare(
        `INSERT INTO transactions (
           id, movement_key, reconciliation_key, provider, environment,
           bank_connection_id, account_id, provider_transaction_id, entry_reference,
           status, booking_date, value_date, transaction_datetime, amount, currency,
           direction, description_raw, description_normalized, merchant_name,
           creditor_name, debtor_name, counterparty_iban_masked, bank_transaction_code,
           merchant_category_code, balance_after, category_auto, subcategory_auto,
           reviewed, first_seen_at, last_seen_at, imported_at, source_raw_file,
           raw_fingerprint
         ) VALUES (
           @id, @movement_key, @reconciliation_key, @provider, @environment,
           @bank_connection_id, @account_id, @provider_transaction_id, @entry_reference,
           @status, @booking_date, @value_date, @transaction_datetime, @amount, @currency,
           @direction, @description_raw, @description_normalized, @merchant_name,
           @creditor_name, @debtor_name, @counterparty_iban_masked, @bank_transaction_code,
           @merchant_category_code, @balance_after, @category_auto, @subcategory_auto,
           0, @first_seen_at, @last_seen_at, @imported_at, @source_raw_file,
           @raw_fingerprint
         )`
      )
      .run({
        ...transaction,
        id: createId(),
        first_seen_at: now,
        last_seen_at: now,
        imported_at: now
      });
    return "inserted";
  }
}
