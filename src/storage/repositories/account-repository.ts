import type { SqliteDatabase } from "../database.js";
import type { AccountResource } from "../../enable-banking/schemas.js";
import { createId } from "../../utils/crypto.js";
import { maskIdentifier } from "../../utils/text.js";

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
  bank_name: string;
  connection_alias: string;
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

  public upsert(
    connectionId: string,
    account: AccountResource,
    rawPath: string | null
  ): string {
    const now = new Date().toISOString();
    const existingByHash = account.identification_hash
      ? (this.database
          .prepare(
            `SELECT id FROM accounts
             WHERE bank_connection_id = ? AND identification_hash = ?`
          )
          .get(connectionId, account.identification_hash) as { id: string } | undefined)
      : undefined;
    const existing =
      existingByHash ??
      (this.database
        .prepare(
          `SELECT id FROM accounts
           WHERE bank_connection_id = ? AND provider_account_id = ?`
        )
        .get(connectionId, account.uid) as { id: string } | undefined);

    const iban = account.account_id?.iban;
    if (existing) {
      this.database
        .prepare(
          `UPDATE accounts SET
             provider_account_id = ?, identification_hash = COALESCE(?, identification_hash),
             iban_masked = ?, currency = ?, name = ?, display_name = ?,
             account_type = ?, product_type = ?, active = 1, last_seen_at = ?,
             raw_response_path = ?
           WHERE id = ?`
        )
        .run(
          account.uid,
          account.identification_hash ?? null,
          maskIdentifier(iban),
          account.currency ?? null,
          account.name ?? null,
          account.details ?? account.name ?? null,
          account.cash_account_type ?? null,
          providerText(account.product),
          now,
          rawPath,
          existing.id
        );
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
        account.identification_hash ?? null,
        maskIdentifier(iban),
        account.currency ?? null,
        account.name ?? null,
        account.details ?? account.name ?? null,
        account.cash_account_type ?? null,
        providerText(account.product),
        now,
        now,
        rawPath
      );
    return id;
  }

  public listActive(connectionId?: string): StoredAccount[] {
    const where = connectionId ? "AND a.bank_connection_id = ?" : "";
    return this.database
      .prepare(
        `SELECT a.*, c.bank_name, c.alias AS connection_alias
         FROM accounts a
         JOIN bank_connections c ON c.id = a.bank_connection_id
         WHERE a.active = 1 ${where}
         ORDER BY c.bank_name, COALESCE(a.account_alias, a.display_name, a.name)`
      )
      .all(...(connectionId ? [connectionId] : [])) as StoredAccount[];
  }
}
