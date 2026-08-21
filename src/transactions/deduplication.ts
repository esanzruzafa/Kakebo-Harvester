import type { SqliteDatabase } from "../storage/database.js";
import { createId } from "../utils/crypto.js";
import type { NormalizedTransaction } from "./transaction-mapper.js";

export type UpsertOutcome = "inserted" | "updated" | "duplicate" | "reconciled";

interface ExistingTransaction {
  id: string;
  movement_key: string;
  raw_fingerprint: string;
  reviewed: number;
  category_auto: string | null;
  subcategory_auto: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export const DEFAULT_PENDING_RECONCILIATION_WINDOW_DAYS = 14;

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
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly pendingReconciliationWindowDays =
      DEFAULT_PENDING_RECONCILIATION_WINDOW_DAYS
  ) {}

  private reconciliationDate(transaction: NormalizedTransaction): string | null {
    return (
      transaction.booking_date ??
      transaction.value_date ??
      transaction.transaction_datetime?.slice(0, 10) ??
      null
    );
  }

  private findIdentityMatches(
    transaction: NormalizedTransaction
  ): ExistingTransaction[] {
    return this.database
      .prepare(
        `SELECT id, movement_key, raw_fingerprint, reviewed, category_auto,
                subcategory_auto, first_seen_at, last_seen_at
         FROM transactions
         WHERE account_id = @account_id
           AND provider = @provider
           AND environment = @environment
           AND bank_connection_id = @bank_connection_id
           AND (
             (@entry_reference IS NOT NULL AND entry_reference = @entry_reference)
             OR (
               @provider_transaction_id IS NOT NULL
               AND provider_transaction_id = @provider_transaction_id
             )
             OR (
               @entry_reference IS NULL
               AND @provider_transaction_id IS NULL
               AND entry_reference IS NULL
               AND provider_transaction_id IS NULL
               AND status = @status
               AND booking_date IS @booking_date
               AND value_date IS @value_date
               AND transaction_datetime IS @transaction_datetime
               AND amount = @amount
               AND currency = @currency
               AND description_normalized IS @description_normalized
               AND merchant_name IS @merchant_name
               AND creditor_name IS @creditor_name
               AND debtor_name IS @debtor_name
               AND counterparty_iban_masked IS @counterparty_iban_masked
             )
           )
         ORDER BY reviewed DESC, first_seen_at, id`
      )
      .all(transaction) as ExistingTransaction[];
  }

  private consolidateIdentityMatches(
    matches: ExistingTransaction[]
  ): ExistingTransaction | undefined {
    const survivor = matches[0];
    if (!survivor) return undefined;
    const reviewed = matches.find((match) => match.reviewed === 1);
    const firstSeenAt = matches
      .map((match) => match.first_seen_at)
      .sort()[0] ?? survivor.first_seen_at;
    const lastSeenAt = matches
      .map((match) => match.last_seen_at)
      .sort()
      .at(-1) ?? survivor.last_seen_at;
    for (const duplicate of matches.slice(1)) {
      this.database.prepare("DELETE FROM transactions WHERE id = ?").run(duplicate.id);
    }
    this.database
      .prepare(
        `UPDATE transactions SET
           reviewed = ?, category_auto = ?, subcategory_auto = ?,
           first_seen_at = ?, last_seen_at = ?
         WHERE id = ?`
      )
      .run(
        reviewed ? 1 : survivor.reviewed,
        reviewed?.category_auto ?? survivor.category_auto,
        reviewed?.subcategory_auto ?? survivor.subcategory_auto,
        firstSeenAt,
        lastSeenAt,
        survivor.id
      );
    return {
      ...survivor,
      reviewed: reviewed ? 1 : survivor.reviewed,
      category_auto: reviewed?.category_auto ?? survivor.category_auto,
      subcategory_auto: reviewed?.subcategory_auto ?? survivor.subcategory_auto,
      first_seen_at: firstSeenAt,
      last_seen_at: lastSeenAt
    };
  }

  public upsert(transaction: NormalizedTransaction): UpsertOutcome {
    return this.database.transaction(() =>
      this.upsertWithinTransaction(transaction)
    )();
  }

  private upsertWithinTransaction(
    transaction: NormalizedTransaction
  ): UpsertOutcome {
    const now = new Date().toISOString();
    const existing = this.consolidateIdentityMatches(
      this.findIdentityMatches(transaction)
    );

    if (existing) {
      this.database.prepare(updateSql).run({
        ...transaction,
        id: existing.id,
        last_seen_at: now,
        imported_at: now
      });
      return existing.raw_fingerprint === transaction.raw_fingerprint
        ? "duplicate"
        : "updated";
    }

    const movementMatch = this.database
      .prepare("SELECT id, raw_fingerprint FROM transactions WHERE movement_key = ?")
      .get(transaction.movement_key) as
      | { id: string; raw_fingerprint: string }
      | undefined;
    if (movementMatch) {
      if (movementMatch.raw_fingerprint === transaction.raw_fingerprint) {
        this.database
          .prepare("UPDATE transactions SET last_seen_at = ? WHERE id = ?")
          .run(now, movementMatch.id);
        return "duplicate";
      }
      this.database.prepare(updateSql).run({
        ...transaction,
        id: movementMatch.id,
        last_seen_at: now,
        imported_at: now
      });
      return "updated";
    }

    const reconciliationDate = this.reconciliationDate(transaction);
    if (transaction.status === "booked" && reconciliationDate) {
      const pending = this.database
        .prepare(
          `SELECT id FROM transactions
           WHERE account_id = ? AND status = 'pending'
             AND (
               reconciliation_key = ?
               OR (
                 amount = ?
                 AND currency = ?
                 AND description_normalized IS ?
                 AND merchant_name IS ?
                 AND creditor_name IS ?
                 AND debtor_name IS ?
                 AND counterparty_iban_masked IS ?
               )
             )
             AND ABS(
               julianday(COALESCE(booking_date, value_date, substr(transaction_datetime, 1, 10)))
               - julianday(?)
             ) <= ?
           ORDER BY ABS(
             julianday(COALESCE(booking_date, value_date, substr(transaction_datetime, 1, 10)))
             - julianday(?)
           ), first_seen_at DESC
           LIMIT 1`
        )
        .get(
          transaction.account_id,
          transaction.reconciliation_key,
          transaction.amount,
          transaction.currency,
          transaction.description_normalized,
          transaction.merchant_name,
          transaction.creditor_name,
          transaction.debtor_name,
          transaction.counterparty_iban_masked,
          reconciliationDate,
          this.pendingReconciliationWindowDays,
          reconciliationDate
        ) as { id: string } | undefined;
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
