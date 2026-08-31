import type { SqliteDatabase } from "../storage/database.js";
import { InvalidStateError } from "../errors.js";
import { sha256 } from "../utils/crypto.js";

export interface PendingAuthorization {
  bankConnectionId: string;
  bankName: string;
  redirectUrl: string;
  environment: string;
  purpose: "connect" | "reauthorize";
}

interface PendingRow {
  bank_connection_id: string;
  bank_name: string;
  redirect_url: string;
  environment: string;
  purpose: "connect" | "reauthorize";
  expires_at: string;
  consumed_at: string | null;
}

export class StateStore {
  public constructor(private readonly database: SqliteDatabase) {}

  public activeConnectionId(state: string): string | undefined {
    const row = this.database
      .prepare(
        `SELECT bank_connection_id
         FROM pending_authorizations
         WHERE state_hash = ?
           AND consumed_at IS NULL
           AND expires_at > ?`
      )
      .get(sha256(state), new Date().toISOString()) as
      | { bank_connection_id: string }
      | undefined;
    return row?.bank_connection_id;
  }

  public save(
    state: string,
    pending: PendingAuthorization,
    ttlMinutes = 15
  ): void {
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60_000);
    const createdAtIso = createdAt.toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE pending_authorizations
           SET consumed_at = ?
           WHERE bank_connection_id = ? AND consumed_at IS NULL`
        )
        .run(createdAtIso, pending.bankConnectionId);
      this.database
        .prepare(
          `INSERT INTO pending_authorizations (
             state_hash, bank_connection_id, bank_name, redirect_url,
             environment, purpose, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sha256(state),
          pending.bankConnectionId,
          pending.bankName,
          pending.redirectUrl,
          pending.environment,
          pending.purpose,
          createdAtIso,
          expiresAt.toISOString()
        );
    });
    transaction();
  }

  public consume(state: string): PendingAuthorization {
    const hash = sha256(state);
    const transaction = this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT bank_connection_id, bank_name, redirect_url, environment,
                  purpose, expires_at, consumed_at
           FROM pending_authorizations WHERE state_hash = ?`
        )
        .get(hash) as PendingRow | undefined;

      if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
        throw new InvalidStateError();
      }
      const result = this.database
        .prepare(
          `UPDATE pending_authorizations SET consumed_at = ?
           WHERE state_hash = ? AND consumed_at IS NULL`
        )
        .run(new Date().toISOString(), hash);
      if (result.changes !== 1) throw new InvalidStateError();
      return {
        bankConnectionId: row.bank_connection_id,
        bankName: row.bank_name,
        redirectUrl: row.redirect_url,
        environment: row.environment,
        purpose: row.purpose
      };
    });
    return transaction();
  }

  public discard(state: string): boolean {
    return (
      this.database
        .prepare(
          `DELETE FROM pending_authorizations
           WHERE state_hash = ? AND consumed_at IS NULL`
        )
        .run(sha256(state)).changes === 1
    );
  }
}
