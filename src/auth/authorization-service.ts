import type { AppConfig, PsuType } from "../config.js";
import type { EnableBankingClient } from "../enable-banking/client.js";
import type { Aspsp } from "../enable-banking/schemas.js";
import type { SqliteDatabase } from "../storage/database.js";
import { RawStore } from "../storage/raw-store.js";
import { AccountRepository } from "../storage/repositories/account-repository.js";
import {
  createAuthorizationState,
  createId,
  decryptSecret,
  encryptSecret
} from "../utils/crypto.js";
import {
  AuthorizationDeniedError,
  InvalidStateError,
  KakeboError,
  providerErrorCode
} from "../errors.js";
import { safeMessage } from "../utils/text.js";
import { StateStore } from "./state-store.js";

export interface AuthorizationStartResult {
  url: string;
  connectionAlias: string;
  connectionId: string;
}

export interface AuthorizationCompletionResult {
  connectionId: string;
  bankName: string;
  status: "authorized" | "denied" | "failed";
  message?: string;
}

export interface AuthorizationCompletionInput {
  state?: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

interface ConnectionRow {
  id: string;
  bank_name: string;
  bank_country: string;
  psu_type: PsuType;
  alias: string;
}

export class AuthorizationService {
  private readonly states: StateStore;
  private readonly accounts: AccountRepository;
  private readonly rawStore: RawStore;

  private hasUsableAuthorizedSession(connectionId: string): boolean {
    const now = new Date().toISOString();
    return Boolean(
      this.database
        .prepare(
          `SELECT 1
           FROM bank_connections c
           JOIN provider_sessions s ON s.bank_connection_id = c.id
           WHERE c.id = ?
             AND c.status = 'AUTHORIZED'
             AND c.reauthorization_required = 0
             AND (c.valid_until IS NULL OR c.valid_until > ?)
             AND s.status = 'AUTHORIZED'
             AND (s.valid_until IS NULL OR s.valid_until > ?)
           LIMIT 1`
        )
        .get(connectionId, now, now)
    );
  }

  private failedAuthorizationState(
    purpose: "connect" | "reauthorize",
    connectionId: string,
    initialStatus: string
  ): { status: string; reauthorizationRequired: number } {
    if (
      purpose === "reauthorize" &&
      this.hasUsableAuthorizedSession(connectionId)
    ) {
      return { status: "AUTHORIZED", reauthorizationRequired: 0 };
    }
    return {
      status: purpose === "reauthorize" ? "REAUTHORIZATION_REQUIRED" : initialStatus,
      reauthorizationRequired: purpose === "reauthorize" ? 1 : 0
    };
  }

  public constructor(
    private readonly config: AppConfig,
    private readonly database: SqliteDatabase,
    private readonly client: EnableBankingClient
  ) {
    this.states = new StateStore(database);
    this.accounts = new AccountRepository(database);
    this.rawStore = new RawStore(config);
    this.cleanupExpiredPendingConnections();
  }

  private cleanupExpiredPendingConnections(): void {
    const now = new Date().toISOString();
    const rows = this.database
      .prepare(
        `SELECT c.id
         FROM bank_connections c
         WHERE c.status = 'PENDING_AUTHORIZATION'
           AND c.environment = ?
           AND NOT EXISTS (
             SELECT 1 FROM provider_sessions s
             WHERE s.bank_connection_id = c.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM pending_authorizations p
             WHERE p.bank_connection_id = c.id
               AND p.consumed_at IS NULL
               AND p.expires_at > ?
           )`
      )
      .all(this.config.appEnv, now) as Array<{ id: string }>;
    for (const row of rows) this.abandonConnection(row.id);
  }

  public abandonConnection(connectionId: string): boolean {
    return this.database.transaction(() => {
      const removable = this.database
        .prepare(
          `SELECT 1 FROM bank_connections c
           WHERE c.id = ?
             AND c.status IN (
               'PENDING_AUTHORIZATION', 'DENIED', 'AUTHORIZATION_FAILED'
             )
             AND NOT EXISTS (
               SELECT 1 FROM provider_sessions s
               WHERE s.bank_connection_id = c.id
             )`
        )
        .get(connectionId);
      if (!removable) return false;
      this.database
        .prepare("DELETE FROM pending_authorizations WHERE bank_connection_id = ?")
        .run(connectionId);
      return (
        this.database
          .prepare("DELETE FROM bank_connections WHERE id = ?")
          .run(connectionId).changes === 1
      );
    })();
  }

  public pendingConnectionId(state: string | undefined): string | undefined {
    return state ? this.states.activeConnectionId(state) : undefined;
  }

  private async findBank(
    bankSearch: string,
    country: string,
    psuType: PsuType
  ): Promise<Aspsp> {
    const banks = await this.client.listBanks(country, psuType);
    const needle = bankSearch.toLocaleLowerCase();
    const exact = banks.find((bank) => bank.name.toLocaleLowerCase() === needle);
    const candidates = exact
      ? [exact]
      : banks.filter((bank) => bank.name.toLocaleLowerCase().includes(needle));
    if (candidates.length !== 1) {
      const names = candidates.slice(0, 10).map((bank) => bank.name).join(", ");
      throw new Error(
        candidates.length === 0
          ? `No se encontró "${bankSearch}" en ${country}.`
          : `La búsqueda es ambigua. Coincidencias: ${names}`
      );
    }
    const bank = candidates[0];
    if (!bank) throw new Error("No bank selected.");
    return bank;
  }

  private async start(
    connection: ConnectionRow,
    bank: Aspsp,
    purpose: "connect" | "reauthorize"
  ): Promise<AuthorizationStartResult> {
    const now = new Date().toISOString();
    const state = createAuthorizationState();
    this.states.save(state, {
      bankConnectionId: connection.id,
      bankName: bank.name,
      redirectUrl: this.config.redirectUrl,
      environment: this.config.appEnv,
      purpose
    });
    let authorization: Awaited<
      ReturnType<EnableBankingClient["startAuthorization"]>
    >;
    try {
      authorization = await this.client.startAuthorization({
        bank,
        state,
        redirectUrl: this.config.redirectUrl,
        psuType: connection.psu_type,
        language: this.config.defaultLanguage
      });
    } catch (error) {
      this.states.discard(state);
      throw error;
    }
    try {
      this.database
        .prepare(
          `UPDATE bank_connections SET
           status = CASE
             WHEN @purpose = 'connect' THEN 'PENDING_AUTHORIZATION'
             ELSE status
           END,
           error_code = CASE
             WHEN @purpose = 'reauthorize' AND retry_after_at > @now
               THEN error_code
             ELSE NULL
           END,
           error_message_safe = CASE
             WHEN @purpose = 'reauthorize' AND retry_after_at > @now
               THEN error_message_safe
             ELSE NULL
           END,
           retry_after_at = CASE
             WHEN @purpose = 'reauthorize' AND retry_after_at > @now
               THEN retry_after_at
             ELSE NULL
           END,
           online_retry_used = CASE
             WHEN @purpose = 'reauthorize' AND retry_after_at > @now
               THEN online_retry_used
             ELSE 0
           END,
           required_psu_headers_json = @requiredHeaders
           WHERE id = @connectionId`
        )
        .run({
          purpose,
          now,
          requiredHeaders: JSON.stringify(
            (bank.required_psu_headers ?? []).map((header) =>
              header.toLowerCase()
            )
          ),
          connectionId: connection.id
        });
    } catch (error) {
      this.states.discard(state);
      throw error;
    }
    return {
      url: authorization.url,
      connectionAlias: connection.alias,
      connectionId: connection.id
    };
  }

  public async connect(input: {
    bankSearch: string;
    country: string;
    psuType: PsuType;
  }): Promise<AuthorizationStartResult> {
    const bank = await this.findBank(input.bankSearch, input.country, input.psuType);
    const connection: ConnectionRow = {
      id: createId(),
      bank_name: bank.name,
      bank_country: bank.country,
      psu_type: input.psuType,
      alias: `${bank.name} ${input.psuType}`
    };
    this.database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES (?, 'enable-banking', ?, ?, ?, ?, ?, 'PENDING_AUTHORIZATION', ?)`
      )
      .run(
        connection.id,
        this.config.appEnv,
        connection.bank_name,
        connection.bank_country,
        connection.psu_type,
        connection.alias,
        new Date().toISOString()
      );
    try {
      return await this.start(connection, bank, "connect");
    } catch (error) {
      this.database.transaction(() => {
        this.database
          .prepare("DELETE FROM pending_authorizations WHERE bank_connection_id = ?")
          .run(connection.id);
        this.database
          .prepare("DELETE FROM bank_connections WHERE id = ?")
          .run(connection.id);
      })();
      throw error;
    }
  }

  public async reauthorize(connectionId: string): Promise<AuthorizationStartResult> {
    const connection = this.database
      .prepare(
        `SELECT id, bank_name, bank_country, psu_type, alias
         FROM bank_connections
         WHERE id = ? AND environment = ? AND status <> 'REVOKED'`
      )
      .get(connectionId, this.config.appEnv) as ConnectionRow | undefined;
    if (!connection) {
      throw new Error("The bank connection does not exist or has been revoked.");
    }
    const bank = await this.findBank(
      connection.bank_name,
      connection.bank_country,
      connection.psu_type
    );
    return await this.start(connection, bank, "reauthorize");
  }

  public async complete(
    input: AuthorizationCompletionInput
  ): Promise<AuthorizationCompletionResult> {
    if (!input.state) throw new AuthorizationDeniedError("El callback no contiene state.");
    const pending = this.states.consume(input.state);
    if (
      pending.environment !== this.config.appEnv ||
      pending.redirectUrl !== this.config.redirectUrl
    ) {
      throw new InvalidStateError();
    }
    if (input.error || !input.code) {
      const now = new Date().toISOString();
      const message = safeMessage(
        input.errorDescription ??
          (input.error ? "Autorización denegada." : "El callback no contiene code.")
      ).slice(0, 300);
      const fallback = this.failedAuthorizationState(
        pending.purpose,
        pending.bankConnectionId,
        "DENIED"
      );
      this.database
        .prepare(
          `UPDATE bank_connections SET
             status = ?, reauthorization_required = ?,
             error_code = CASE
               WHEN ? = 'reauthorize' AND retry_after_at > ?
                 THEN error_code
               ELSE ?
             END,
             error_message_safe = CASE
               WHEN ? = 'reauthorize' AND retry_after_at > ?
                 THEN error_message_safe
               ELSE ?
             END
           WHERE id = ?`
        )
        .run(
          fallback.status,
          fallback.reauthorizationRequired,
          pending.purpose,
          now,
          input.error ?? "MISSING_AUTHORIZATION_CODE",
          pending.purpose,
          now,
          message,
          pending.bankConnectionId
        );
      return {
        connectionId: pending.bankConnectionId,
        bankName: pending.bankName,
        status: "denied",
        message
      };
    }

    let createdSession:
      | Awaited<ReturnType<EnableBankingClient["authorizeSession"]>>
      | undefined;
    try {
      const session = await this.client.authorizeSession(input.code);
      createdSession = session;
      const previousSessions = this.database
        .prepare(
          `SELECT id, provider_session_id_ciphertext
           FROM provider_sessions
           WHERE bank_connection_id = ?
             AND status IN ('AUTHORIZED', 'REVOCATION_REQUIRED')`
        )
        .all(pending.bankConnectionId) as Array<{
          id: string;
          provider_session_id_ciphertext: string;
        }>;
      const raw = await this.rawStore.write("session", pending.bankConnectionId, {
        ...session,
        session_id: "[REDACTED]"
      });
      const now = new Date().toISOString();
      const validUntil = session.access?.valid_until ?? null;
      const dbTransaction = this.database.transaction(() => {
        this.database
          .prepare(
            `UPDATE provider_sessions SET status = 'REVOCATION_REQUIRED'
             WHERE bank_connection_id = ? AND status = 'AUTHORIZED'`
          )
          .run(pending.bankConnectionId);
        this.database
          .prepare(
            `UPDATE accounts SET active = 0
             WHERE bank_connection_id = ?`
          )
          .run(pending.bankConnectionId);
        this.database
          .prepare(
            `INSERT INTO provider_sessions (
               id, bank_connection_id, provider_session_id_ciphertext, created_at,
               valid_until, status, raw_response_path
             ) VALUES (?, ?, ?, ?, ?, 'AUTHORIZED', ?)`
          )
          .run(
            createId(),
            pending.bankConnectionId,
            encryptSecret(session.session_id, this.config.sessionEncryptionKey),
            now,
            validUntil,
            raw.path
          );
        this.database
          .prepare(
            `UPDATE bank_connections SET
               status = 'AUTHORIZED', last_authorized_at = ?, valid_until = ?,
               reauthorization_required = 0,
               error_code = CASE
                 WHEN retry_after_at > ? THEN error_code
                 ELSE NULL
               END,
               error_message_safe = CASE
                 WHEN retry_after_at > ? THEN error_message_safe
                 ELSE NULL
               END,
               retry_after_at = CASE
                 WHEN retry_after_at > ? THEN retry_after_at
                 ELSE NULL
               END,
               online_retry_used = CASE
                 WHEN retry_after_at > ? THEN online_retry_used
                 ELSE 0
               END
             WHERE id = ?`
          )
          .run(
            now,
            validUntil,
            now,
            now,
            now,
            now,
            pending.bankConnectionId
          );
        for (const account of session.accounts) {
          this.accounts.upsert(pending.bankConnectionId, account, raw.path);
        }
      });
      dbTransaction();
      for (const previous of previousSessions) {
        try {
          await this.client.deleteSession(
            decryptSecret(
              previous.provider_session_id_ciphertext,
              this.config.sessionEncryptionKey
            )
          );
          this.database
            .prepare("DELETE FROM provider_sessions WHERE id = ?")
            .run(previous.id);
        } catch {
          // The durable recovery row remains available to renewal and disconnect.
        }
      }
      return {
        connectionId: pending.bankConnectionId,
        bankName: pending.bankName,
        status: "authorized"
      };
    } catch (error) {
      if (createdSession) {
        try {
          await this.client.deleteSession(createdSession.session_id);
        } catch {
          try {
            this.database
              .prepare(
                `INSERT INTO provider_sessions (
                   id, bank_connection_id, provider_session_id_ciphertext,
                   created_at, valid_until, status, raw_response_path
                 ) VALUES (?, ?, ?, ?, ?, 'REVOCATION_REQUIRED', NULL)`
              )
              .run(
                createId(),
                pending.bankConnectionId,
                encryptSecret(
                  createdSession.session_id,
                  this.config.sessionEncryptionKey
                ),
                new Date().toISOString(),
                createdSession.access?.valid_until ?? null
              );
          } catch {
            // The remote revocation was attempted first. Local recovery storage is best effort.
          }
        }
      }
      const message = safeMessage(error);
      const now = new Date().toISOString();
      const fallback = this.failedAuthorizationState(
        pending.purpose,
        pending.bankConnectionId,
        "AUTHORIZATION_FAILED"
      );
      this.database
        .prepare(
          `UPDATE bank_connections SET
             status = ?, reauthorization_required = ?,
             error_code = CASE
               WHEN ? = 'reauthorize' AND retry_after_at > ?
                 THEN error_code
               ELSE ?
             END,
             error_message_safe = CASE
               WHEN ? = 'reauthorize' AND retry_after_at > ?
                 THEN error_message_safe
               ELSE ?
             END
           WHERE id = ?`
        )
        .run(
          fallback.status,
          fallback.reauthorizationRequired,
          pending.purpose,
          now,
          providerErrorCode(error) ??
            (error instanceof KakeboError ? error.code : "CALLBACK_ERROR"),
          pending.purpose,
          now,
          message,
          pending.bankConnectionId
        );
      return {
        connectionId: pending.bankConnectionId,
        bankName: pending.bankName,
        status: "failed",
        message
      };
    }
  }
}
