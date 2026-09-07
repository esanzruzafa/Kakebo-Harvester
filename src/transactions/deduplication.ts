import type { SqliteDatabase } from "../storage/database.js";
import { createId } from "../utils/crypto.js";
import type { NormalizedTransaction } from "./transaction-mapper.js";

export type UpsertOutcome = "inserted" | "updated" | "duplicate" | "reconciled";

export interface FallbackIdentityResolution {
  occurrence: number;
  matchExistingFallback: boolean;
}

interface ExistingTransaction {
  id: string;
  movement_key: string;
  fallback_occurrence: number | null;
  raw_fingerprint: string;
  reviewed: number;
  category_auto: string | null;
  subcategory_auto: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export const DEFAULT_PENDING_RECONCILIATION_WINDOW_DAYS = 14;

const compatibleProviderDatesSql = `
  AND (
    booking_date IS @booking_date
    OR booking_date IS NULL
    OR @booking_date IS NULL
  )
  AND (
    value_date IS @value_date
    OR value_date IS NULL
    OR @value_date IS NULL
  )
  AND (
    transaction_datetime IS @transaction_datetime
    OR transaction_datetime IS NULL
    OR @transaction_datetime IS NULL
  )
  AND (
    (
      booking_date IS NULL
      AND value_date IS NULL
      AND transaction_datetime IS NULL
    )
    OR (
      @booking_date IS NULL
      AND @value_date IS NULL
      AND @transaction_datetime IS NULL
    )
    OR (booking_date IS NOT NULL AND booking_date IS @booking_date)
    OR (value_date IS NOT NULL AND value_date IS @value_date)
    OR (
      transaction_datetime IS NOT NULL
      AND transaction_datetime IS @transaction_datetime
    )
  )`;

const compatibleStatusSql = `
  AND (status IS @status OR status = 'unknown' OR @status = 'unknown')`;

const compatibleDescriptionSql = `
  AND (
    description_normalized IS @description_normalized
    OR description_normalized = ''
    OR @description_normalized = ''
  )`;

const compatibleCounterpartySql = `
  AND (merchant_name IS @merchant_name OR merchant_name IS NULL OR @merchant_name IS NULL)
  AND (creditor_name IS @creditor_name OR creditor_name IS NULL OR @creditor_name IS NULL)
  AND (debtor_name IS @debtor_name OR debtor_name IS NULL OR @debtor_name IS NULL)
  AND (
    counterparty_iban_masked IS @counterparty_iban_masked
    OR counterparty_iban_masked IS NULL
    OR @counterparty_iban_masked IS NULL
  )
  AND (
    (
      merchant_name IS NULL
      AND creditor_name IS NULL
      AND debtor_name IS NULL
      AND counterparty_iban_masked IS NULL
    )
    OR (
      @merchant_name IS NULL
      AND @creditor_name IS NULL
      AND @debtor_name IS NULL
      AND @counterparty_iban_masked IS NULL
    )
    OR (merchant_name IS NOT NULL AND merchant_name IS @merchant_name)
    OR (creditor_name IS NOT NULL AND creditor_name IS @creditor_name)
    OR (debtor_name IS NOT NULL AND debtor_name IS @debtor_name)
    OR (
      counterparty_iban_masked IS NOT NULL
      AND counterparty_iban_masked IS @counterparty_iban_masked
    )
  )`;

const updateSql = `
  UPDATE transactions SET
    movement_key = CASE
      WHEN @preserve_movement_key = 1 THEN movement_key
      ELSE @movement_key
    END,
    reconciliation_key = CASE
      WHEN (
        @merchant_name IS NULL
        AND @creditor_name IS NULL
        AND @debtor_name IS NULL
        AND @counterparty_iban_masked IS NULL
        AND (
          merchant_name IS NOT NULL
          OR creditor_name IS NOT NULL
          OR debtor_name IS NOT NULL
          OR counterparty_iban_masked IS NOT NULL
        )
      )
      OR (
        @description_normalized = ''
        AND description_normalized <> ''
      )
      THEN reconciliation_key
      ELSE @reconciliation_key
    END,
    provider_transaction_id = COALESCE(@provider_transaction_id, provider_transaction_id),
    entry_reference = COALESCE(@entry_reference, entry_reference),
    fallback_occurrence = @fallback_occurrence,
    status = CASE
      WHEN @status = 'unknown' AND status <> 'unknown' THEN status
      WHEN status = 'booked' AND @status = 'pending' THEN status
      ELSE @status
    END,
    booking_date = COALESCE(@booking_date, booking_date),
    value_date = COALESCE(@value_date, value_date),
    transaction_datetime = COALESCE(@transaction_datetime, transaction_datetime),
    amount = @amount,
    currency = @currency,
    direction = @direction,
    description_raw = CASE
      WHEN @description_normalized = '' AND description_normalized <> ''
      THEN description_raw
      ELSE @description_raw
    END,
    description_normalized = CASE
      WHEN @description_normalized = '' AND description_normalized <> ''
      THEN description_normalized
      ELSE @description_normalized
    END,
    merchant_name = COALESCE(@merchant_name, merchant_name),
    creditor_name = COALESCE(@creditor_name, creditor_name),
    debtor_name = COALESCE(@debtor_name, debtor_name),
    counterparty_iban_masked = COALESCE(
      @counterparty_iban_masked,
      counterparty_iban_masked
    ),
    bank_transaction_code = @bank_transaction_code,
    merchant_category_code = @merchant_category_code,
    balance_after = @balance_after,
    category_auto = CASE WHEN reviewed = 1 THEN category_auto ELSE @category_auto END,
    subcategory_auto = CASE WHEN reviewed = 1 THEN subcategory_auto ELSE @subcategory_auto END,
    last_seen_at = @last_seen_at,
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
    transaction: NormalizedTransaction,
    matchExistingFallback = false
  ): ExistingTransaction[] {
    return this.database
      .prepare(
        `SELECT id, movement_key, fallback_occurrence, raw_fingerprint, reviewed, category_auto,
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
               AND (
                 fallback_occurrence IS @fallback_occurrence
                 OR (fallback_occurrence IS NULL AND @fallback_occurrence = 1)
               )
               ${compatibleStatusSql}
               ${compatibleProviderDatesSql}
               AND amount = @amount
               AND currency = @currency
               ${compatibleDescriptionSql}
               ${compatibleCounterpartySql}
             )
             OR (
               @match_existing_fallback = 1
               AND (@entry_reference IS NOT NULL OR @provider_transaction_id IS NOT NULL)
               AND entry_reference IS NULL
               AND provider_transaction_id IS NULL
               AND fallback_occurrence IS @fallback_occurrence
               ${compatibleStatusSql}
               ${compatibleProviderDatesSql}
               AND amount = @amount
               AND currency = @currency
               ${compatibleDescriptionSql}
               ${compatibleCounterpartySql}
             )
           )
         ORDER BY reviewed DESC, first_seen_at, id`
      )
      .all({ ...transaction, match_existing_fallback: matchExistingFallback ? 1 : 0 }) as ExistingTransaction[];
  }

  public resolveFallbackIdentity(
    transaction: NormalizedTransaction,
    fallbackIdentity: NormalizedTransaction,
    claimedOccurrences: ReadonlySet<number>
  ): FallbackIdentityResolution {
    const exactIdentity =
      transaction.entry_reference || transaction.provider_transaction_id
        ? (this.database
            .prepare(
              `SELECT fallback_occurrence
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
                 )
               ORDER BY first_seen_at, id
               LIMIT 1`
            )
            .get(transaction) as { fallback_occurrence: number | null } | undefined)
        : undefined;
    if (exactIdentity?.fallback_occurrence !== null && exactIdentity !== undefined) {
      return {
        occurrence: exactIdentity.fallback_occurrence,
        matchExistingFallback: false
      };
    }

    const stableMatches = this.database
      .prepare(
        `SELECT entry_reference, provider_transaction_id, fallback_occurrence
         FROM transactions
         WHERE account_id = @account_id
           AND provider = @provider
           AND environment = @environment
           AND bank_connection_id = @bank_connection_id
           ${compatibleStatusSql}
           ${compatibleProviderDatesSql}
           AND amount = @amount
           AND currency = @currency
           ${compatibleDescriptionSql}
           ${compatibleCounterpartySql}
         ORDER BY COALESCE(fallback_occurrence, 1), first_seen_at, id`
      )
      .all(fallbackIdentity) as Array<{
        entry_reference: string | null;
        provider_transaction_id: string | null;
        fallback_occurrence: number | null;
      }>;
    if (exactIdentity) {
      const unavailable = new Set(claimedOccurrences);
      for (const match of stableMatches) {
        if (match.fallback_occurrence !== null) {
          unavailable.add(match.fallback_occurrence);
        }
      }
      let occurrence = 1;
      while (unavailable.has(occurrence)) occurrence += 1;
      return { occurrence, matchExistingFallback: false };
    }
    const incomingHasIdentity =
      transaction.entry_reference !== null ||
      transaction.provider_transaction_id !== null;
    const unclaimedStableMatch = stableMatches.find(
      (match) =>
        (!incomingHasIdentity ||
          (match.entry_reference === null &&
            match.provider_transaction_id === null)) &&
        !claimedOccurrences.has(match.fallback_occurrence ?? 1)
    );
    if (unclaimedStableMatch) {
      return {
        occurrence: unclaimedStableMatch.fallback_occurrence ?? 1,
        matchExistingFallback: incomingHasIdentity
      };
    }

    const unavailable = new Set(claimedOccurrences);
    for (const match of stableMatches) {
      if (match.fallback_occurrence !== null) {
        unavailable.add(match.fallback_occurrence);
      }
    }
    let occurrence = 1;
    while (unavailable.has(occurrence)) occurrence += 1;
    return { occurrence, matchExistingFallback: false };
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

  public consolidateAccountTransactions(accountId: string): number {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT * FROM transactions
           WHERE account_id = ?
           ORDER BY first_seen_at, id`
        )
        .all(accountId) as NormalizedTransaction[];
      let removed = 0;
      for (const row of rows) {
        const stillPresent = this.database
          .prepare("SELECT 1 FROM transactions WHERE movement_key = ?")
          .get(row.movement_key);
        if (!stillPresent) continue;
        const matches = this.findIdentityMatches(row);
        if (matches.length < 2) continue;
        this.consolidateIdentityMatches(matches);
        removed += matches.length - 1;
      }
      return removed;
    })();
  }

  public upsert(
    transaction: NormalizedTransaction,
    options: { matchExistingFallback?: boolean } = {}
  ): UpsertOutcome {
    return this.database.transaction(() =>
      this.upsertWithinTransaction(transaction, options)
    )();
  }

  private upsertWithinTransaction(
    transaction: NormalizedTransaction,
    options: { matchExistingFallback?: boolean }
  ): UpsertOutcome {
    const now = new Date().toISOString();
    const existing = this.consolidateIdentityMatches(
      this.findIdentityMatches(transaction, options.matchExistingFallback)
    );

    if (existing) {
      this.database.prepare(updateSql).run({
        ...transaction,
        id: existing.id,
        preserve_movement_key:
          existing.fallback_occurrence !== null &&
          existing.movement_key !== transaction.movement_key
            ? 1
            : 0,
        last_seen_at: now
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
        preserve_movement_key: 0,
        last_seen_at: now
      });
      return "updated";
    }

    const reconciliationDate = this.reconciliationDate(transaction);
    if (transaction.status === "booked" && reconciliationDate) {
      const pending = this.database
        .prepare(
          `SELECT id FROM transactions
           WHERE account_id = @account_id AND status = 'pending'
             AND (
               reconciliation_key = @reconciliation_key
               OR (
                 amount = @amount
                 AND currency = @currency
                 ${compatibleDescriptionSql}
                 ${compatibleCounterpartySql}
               )
             )
             AND ABS(
               julianday(COALESCE(booking_date, value_date, substr(transaction_datetime, 1, 10)))
               - julianday(@reconciliation_date)
             ) <= @pending_reconciliation_window_days
           ORDER BY ABS(
             julianday(COALESCE(booking_date, value_date, substr(transaction_datetime, 1, 10)))
             - julianday(@reconciliation_date)
           ), first_seen_at DESC
           LIMIT 1`
        )
        .get({
          ...transaction,
          reconciliation_date: reconciliationDate,
          pending_reconciliation_window_days: this.pendingReconciliationWindowDays
        }) as { id: string } | undefined;
      if (pending) {
        this.database.prepare(updateSql).run({
          ...transaction,
          id: pending.id,
          preserve_movement_key: 0,
          last_seen_at: now
        });
        return "reconciled";
      }
    }

    this.database
      .prepare(
        `INSERT INTO transactions (
           id, movement_key, reconciliation_key, provider, environment,
           bank_connection_id, account_id, provider_transaction_id, entry_reference,
           fallback_occurrence,
           status, booking_date, value_date, transaction_datetime, amount, currency,
           direction, description_raw, description_normalized, merchant_name,
           creditor_name, debtor_name, counterparty_iban_masked, bank_transaction_code,
           merchant_category_code, balance_after, category_auto, subcategory_auto,
           reviewed, first_seen_at, last_seen_at, imported_at, source_raw_file,
           raw_fingerprint
         ) VALUES (
           @id, @movement_key, @reconciliation_key, @provider, @environment,
           @bank_connection_id, @account_id, @provider_transaction_id, @entry_reference,
           @fallback_occurrence,
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
