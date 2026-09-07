import type { SqliteDatabase } from "../database.js";
import type { AccountResource } from "../../enable-banking/schemas.js";
import { createId } from "../../utils/crypto.js";
import { maskIdentifier } from "../../utils/text.js";
import { TransactionRepository } from "../../transactions/deduplication.js";

export interface StoredAccount {
  id: string;
  bank_connection_id: string;
  provider_account_id: string;
  identification_hash: string | null;
  iban_masked: string | null;
  currency: string | null;
  name: string | null;
  display_name: string | null;
  account_alias: string | null;
  account_type: string | null;
  product_type: string | null;
  sync_enabled: number;
  export_enabled: number;
  bank_name: string;
  connection_alias: string;
}

export interface EditableAccount {
  id: string;
  identificationHash: string | null;
  bank: string;
  connection: string;
  account: string;
  masked: string | null;
  currency: string | null;
  productType: string | null;
  alias: string;
  providerActive: boolean;
  syncEnabled: boolean;
  exportEnabled: boolean;
  lastError: {
    at: string;
    code: string;
    message: string;
  } | null;
}

export interface AccountSettingsUpdate {
  id: string;
  alias: string;
  syncEnabled: boolean;
  exportEnabled: boolean;
}

interface AccountIdentityRow {
  id: string;
  identification_hash: string | null;
  iban_masked: string | null;
  account_alias: string | null;
  first_seen_at: string;
}

function isIbanIdentificationHash(value: string | null | undefined): value is string {
  if (!value || value.length > 8_192) return false;
  const separator = value.indexOf(".");
  if (separator <= 0) return false;
  try {
    const descriptor: unknown = JSON.parse(
      Buffer.from(value.slice(0, separator), "base64").toString("utf8")
    );
    return (
      Array.isArray(descriptor) &&
      descriptor.some(
        (path) =>
          Array.isArray(path) &&
          path.length === 3 &&
          path[0] === "account" &&
          path[1] === "account_id" &&
          path[2] === "iban"
      )
    );
  } catch {
    return false;
  }
}

function stableIdentificationHashes(account: AccountResource): string[] {
  return [
    account.identification_hash,
    ...(account.identification_hashes ?? [])
  ].filter(
    (value, index, values): value is string =>
      isIbanIdentificationHash(value) &&
      values.indexOf(value) === index
  );
}

function providerText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(", ");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return value.name;
  }
  return null;
}

export class AccountRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public shouldRefreshDetails(
    connectionId: string,
    providerAccountId: string
  ): boolean {
    const account = this.database
      .prepare(
        `SELECT sync_enabled FROM accounts
         WHERE bank_connection_id = ? AND provider_account_id = ?`
      )
      .get(connectionId, providerAccountId) as { sync_enabled: number } | undefined;
    return account?.sync_enabled !== 0;
  }

  public findByProviderAccountId(
    connectionId: string,
    providerAccountId: string
  ): StoredAccount | undefined {
    return this.database
      .prepare(
        `SELECT a.*, c.bank_name, c.alias AS connection_alias
         FROM accounts a
         JOIN bank_connections c ON c.id = a.bank_connection_id
         WHERE a.bank_connection_id = ? AND a.provider_account_id = ?`
      )
      .get(connectionId, providerAccountId) as StoredAccount | undefined;
  }

  public recordLastSyncError(accountId: string, code: string, message: string): void {
    this.database
      .prepare(
        `UPDATE accounts SET
           last_error_at = ?, last_error_code = ?, last_error_message_safe = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), code, message, accountId);
  }

  public clearLastSyncError(accountId: string): void {
    this.database
      .prepare(
        `UPDATE accounts SET
           last_error_at = NULL, last_error_code = NULL, last_error_message_safe = NULL
         WHERE id = ?`
      )
      .run(accountId);
  }

  public reconcileProviderActiveSet(
    connectionId: string,
    providerAccountIds: string[]
  ): void {
    const now = new Date().toISOString();
    const reconcile = this.database.transaction(() => {
      this.database
        .prepare("UPDATE accounts SET active = 0 WHERE bank_connection_id = ?")
        .run(connectionId);
      if (providerAccountIds.length === 0) return;
      const placeholders = providerAccountIds.map(() => "?").join(", ");
      this.database
        .prepare(
          `UPDATE accounts
           SET active = 1, last_seen_at = ?
           WHERE bank_connection_id = ?
             AND provider_account_id IN (${placeholders})`
        )
        .run(now, connectionId, ...providerAccountIds);
    });
    reconcile();
  }

  private findByIdentificationHashes(
    connectionId: string,
    hashes: string[],
    maskedIban: string | null
  ): AccountIdentityRow[] {
    if (hashes.length === 0 || !maskedIban) return [];
    const placeholders = hashes.map(() => "?").join(", ");
    return this.database
      .prepare(
        `SELECT a.id, a.identification_hash, a.iban_masked,
                a.account_alias, a.first_seen_at
         FROM accounts a
         WHERE a.bank_connection_id = ?
           AND a.iban_masked = ?
           AND (
             a.identification_hash IN (${placeholders})
             OR EXISTS (
               SELECT 1
               FROM account_identification_hashes aliases
               WHERE aliases.bank_connection_id = a.bank_connection_id
                 AND aliases.account_id = a.id
                 AND aliases.verified = 1
                 AND aliases.identification_hash IN (${placeholders})
             )
           )
         ORDER BY (a.account_alias IS NOT NULL) DESC, a.first_seen_at, a.id`
      )
      .all(connectionId, maskedIban, ...hashes, ...hashes) as AccountIdentityRow[];
  }

  private findIdentityByProviderAccountId(
    connectionId: string,
    providerAccountId: string
  ): AccountIdentityRow | undefined {
    return this.database
      .prepare(
        `SELECT id, identification_hash, iban_masked, account_alias, first_seen_at
         FROM accounts
         WHERE bank_connection_id = ? AND provider_account_id = ?`
      )
      .get(connectionId, providerAccountId) as AccountIdentityRow | undefined;
  }

  private mergeAccount(canonicalId: string, duplicateId: string): void {
    if (canonicalId === duplicateId) return;
    this.database
      .prepare(
        `UPDATE accounts
         SET account_alias = COALESCE(
           account_alias,
           (SELECT account_alias FROM accounts WHERE id = ?)
         ),
         sync_enabled = MIN(
           sync_enabled,
           (SELECT sync_enabled FROM accounts WHERE id = ?)
         ),
         export_enabled = MIN(
           export_enabled,
           (SELECT export_enabled FROM accounts WHERE id = ?)
         )
         WHERE id = ?`
      )
      .run(duplicateId, duplicateId, duplicateId, canonicalId);
    for (const table of ["balances", "transactions_raw", "transactions", "sync_runs"]) {
      this.database
        .prepare(`UPDATE ${table} SET account_id = ? WHERE account_id = ?`)
        .run(canonicalId, duplicateId);
    }
    this.database
      .prepare(
        `UPDATE desktop_run_accounts AS canonical
         SET amount = (
               SELECT duplicate.amount
               FROM desktop_run_accounts duplicate
               WHERE duplicate.run_id = canonical.run_id
                 AND duplicate.account_id = ?
             ),
             currency = (
               SELECT duplicate.currency
               FROM desktop_run_accounts duplicate
               WHERE duplicate.run_id = canonical.run_id
                 AND duplicate.account_id = ?
             ),
             balance_type = (
               SELECT duplicate.balance_type
               FROM desktop_run_accounts duplicate
               WHERE duplicate.run_id = canonical.run_id
                 AND duplicate.account_id = ?
             ),
             balance_reference_date = (
               SELECT duplicate.balance_reference_date
               FROM desktop_run_accounts duplicate
               WHERE duplicate.run_id = canonical.run_id
                 AND duplicate.account_id = ?
             ),
             balance_extracted_at = (
               SELECT duplicate.balance_extracted_at
               FROM desktop_run_accounts duplicate
               WHERE duplicate.run_id = canonical.run_id
                 AND duplicate.account_id = ?
             )
         WHERE canonical.account_id = ?
           AND EXISTS (
             SELECT 1
             FROM desktop_run_accounts duplicate
             WHERE duplicate.run_id = canonical.run_id
               AND duplicate.account_id = ?
               AND duplicate.amount IS NOT NULL
               AND (
                 canonical.amount IS NULL
                 OR COALESCE(duplicate.balance_extracted_at, '') >
                    COALESCE(canonical.balance_extracted_at, '')
               )
           )`
      )
      .run(
        duplicateId,
        duplicateId,
        duplicateId,
        duplicateId,
        duplicateId,
        canonicalId,
        duplicateId
      );
    this.database
      .prepare(
        `INSERT OR IGNORE INTO desktop_run_accounts (
           run_id, account_id, bank_name, account_name, amount, currency,
           balance_type, balance_reference_date, balance_extracted_at
         )
         SELECT run_id, ?, bank_name, account_name, amount, currency,
                balance_type, balance_reference_date, balance_extracted_at
         FROM desktop_run_accounts
         WHERE account_id = ?`
      )
      .run(canonicalId, duplicateId);
    this.database
      .prepare("DELETE FROM desktop_run_accounts WHERE account_id = ?")
      .run(duplicateId);
    this.database
      .prepare(
        "UPDATE account_identification_hashes SET account_id = ? WHERE account_id = ?"
      )
      .run(canonicalId, duplicateId);
    this.database.prepare("DELETE FROM accounts WHERE id = ?").run(duplicateId);
    new TransactionRepository(this.database).consolidateAccountTransactions(
      canonicalId
    );
  }

  private registerIdentificationHashes(
    connectionId: string,
    accountId: string,
    hashes: string[]
  ): void {
    if (hashes.length === 0) return;
    this.database
      .prepare(
        `DELETE FROM account_identification_hashes
         WHERE account_id = ? AND verified = 0`
      )
      .run(accountId);
    const statement = this.database.prepare(
      `INSERT INTO account_identification_hashes (
         bank_connection_id, identification_hash, account_id, verified
       ) VALUES (?, ?, ?, 1)
       ON CONFLICT(bank_connection_id, identification_hash)
       DO UPDATE SET account_id = excluded.account_id, verified = 1`
    );
    for (const hash of hashes) statement.run(connectionId, hash, accountId);
  }

  public upsert(
    connectionId: string,
    account: AccountResource,
    rawPath: string | null
  ): string {
    const execute = this.database.transaction(() => {
      const now = new Date().toISOString();
      const hashes = stableIdentificationHashes(account);
      const iban = account.account_id?.iban;
      const maskedIban = maskIdentifier(iban);
      const matchesByHash = this.findByIdentificationHashes(
        connectionId,
        hashes,
        maskedIban
      );
      const matchByProviderId = this.findIdentityByProviderAccountId(
        connectionId,
        account.uid
      );
      const existing = matchesByHash[0] ?? matchByProviderId;
      const duplicateIds = new Set(
        [...matchesByHash, matchByProviderId]
          .filter((row): row is AccountIdentityRow => row !== undefined)
          .map((row) => row.id)
      );
      if (existing) {
        duplicateIds.delete(existing.id);
        for (const duplicateId of duplicateIds) {
          this.mergeAccount(existing.id, duplicateId);
        }
      }

      if (existing) {
        const identificationHash = isIbanIdentificationHash(
          existing.identification_hash
        )
          ? existing.identification_hash
          : (hashes[0] ?? existing.identification_hash);
        this.database
          .prepare(
            `UPDATE accounts SET
               provider_account_id = ?,
               identification_hash = ?,
               iban_masked = COALESCE(?, iban_masked),
               currency = COALESCE(?, currency), name = COALESCE(?, name),
               display_name = COALESCE(?, display_name),
               account_type = COALESCE(?, account_type),
               product_type = COALESCE(?, product_type), active = 1, last_seen_at = ?,
               raw_response_path = COALESCE(?, raw_response_path),
               last_error_at = NULL, last_error_code = NULL,
               last_error_message_safe = NULL
             WHERE id = ?`
          )
          .run(
            account.uid,
            identificationHash,
            maskedIban,
            account.currency ?? null,
            account.name ?? null,
            account.details ?? account.name ?? null,
            account.cash_account_type ?? null,
            providerText(account.product),
            now,
            rawPath,
            existing.id
          );
        this.registerIdentificationHashes(connectionId, existing.id, hashes);
        return existing.id;
      }

      const id = createId();
      this.database
        .prepare(
          `INSERT INTO accounts (
             id, bank_connection_id, provider_account_id, identification_hash,
             iban_masked, currency, name, display_name, account_type, product_type,
             active, first_seen_at, last_seen_at, raw_response_path
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          id,
          connectionId,
          account.uid,
          hashes[0] ?? null,
          maskedIban,
          account.currency ?? null,
          account.name ?? null,
          account.details ?? account.name ?? null,
          account.cash_account_type ?? null,
          providerText(account.product),
          now,
          now,
          rawPath
        );
      this.registerIdentificationHashes(connectionId, id, hashes);
      return id;
    });
    return execute();
  }

  public listActive(connectionId?: string): StoredAccount[] {
    const where = connectionId ? "AND a.bank_connection_id = ?" : "";
    return this.database
      .prepare(
        `SELECT a.*, c.bank_name, c.alias AS connection_alias
         FROM accounts a
         JOIN bank_connections c ON c.id = a.bank_connection_id
         WHERE a.active = 1
           AND a.sync_enabled = 1
           AND c.provider = 'enable-banking'
           AND c.status = 'AUTHORIZED'
           AND c.reauthorization_required = 0
           ${where}
         ORDER BY c.bank_name, COALESCE(a.account_alias, a.display_name, a.name)`
      )
      .all(...(connectionId ? [connectionId] : [])) as StoredAccount[];
  }

  public listEditable(): EditableAccount[] {
    const rows = this.database
      .prepare(
        `SELECT
           a.id,
           a.identification_hash,
           c.bank_name,
           c.alias AS connection_alias,
           COALESCE(a.display_name, a.name, 'Account') AS account_name,
           a.iban_masked,
           a.currency,
           COALESCE(a.product_type, a.account_type) AS product_type,
           a.account_alias,
           a.active,
           a.sync_enabled,
           a.export_enabled,
           a.last_error_at,
           a.last_error_code,
           a.last_error_message_safe,
           c.provider
         FROM accounts a
         JOIN bank_connections c ON c.id = a.bank_connection_id
         ORDER BY c.bank_name, account_name`
      )
      .all() as Array<{
      id: string;
      identification_hash: string | null;
      bank_name: string;
      connection_alias: string;
      account_name: string;
      iban_masked: string | null;
      currency: string | null;
      product_type: string | null;
      account_alias: string | null;
      active: number;
      sync_enabled: number;
      export_enabled: number;
      last_error_at: string | null;
      last_error_code: string | null;
      last_error_message_safe: string | null;
      provider: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      identificationHash: row.identification_hash,
      bank: row.bank_name,
      connection: row.connection_alias,
      account: row.account_name,
      masked: row.iban_masked,
      currency: row.currency,
      productType: row.product_type,
      alias: row.account_alias ?? "",
      providerActive: row.active === 1 && row.provider === "enable-banking",
      syncEnabled: row.sync_enabled === 1,
      exportEnabled: row.export_enabled === 1,
      lastError:
        row.last_error_at && row.last_error_code && row.last_error_message_safe
          ? {
              at: row.last_error_at,
              code: row.last_error_code,
              message: row.last_error_message_safe
            }
          : null
    }));
  }

  public updateSettings(updates: AccountSettingsUpdate[]): void {
    const update = this.database.prepare(
      `UPDATE accounts SET
         account_alias = ?, sync_enabled = ?, export_enabled = ?
       WHERE id = ?`
    );
    const transaction = this.database.transaction(() => {
      for (const item of updates) {
        const alias = item.alias.trim();
        if (alias.length > 120) {
          throw new Error("Account aliases cannot exceed 120 characters.");
        }
        const result = update.run(
          alias || null,
          item.syncEnabled ? 1 : 0,
          item.exportEnabled ? 1 : 0,
          item.id
        );
        if (result.changes !== 1) {
          throw new Error(`Unknown account: ${item.id}`);
        }
      }
    });
    transaction();
  }
}
