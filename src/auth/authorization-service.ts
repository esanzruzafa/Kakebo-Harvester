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

  public constructor(
    private readonly config: AppConfig,
    private readonly database: SqliteDatabase,
    private readonly client: EnableBankingClient
  ) {
    this.states = new StateStore(database);
    this.accounts = new AccountRepository(database);
    this.rawStore = new RawStore(config);
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
    const state = createAuthorizationState();
    this.states.save(state, {
      bankConnectionId: connection.id,
      bankName: bank.name,
      redirectUrl: this.config.redirectUrl,
      environment: this.config.appEnv,
      purpose
    });
    const authorization = await this.client.startAuthorization({
      bank,
      state,
      redirectUrl: this.config.redirectUrl,
      psuType: connection.psu_type,
      language: this.config.defaultLanguage
    });
    this.database
      .prepare(
        `UPDATE bank_connections SET
           status = ?, error_code = NULL, error_message_safe = NULL,
           retry_after_at = NULL, online_retry_used = 0,
           required_psu_headers_json = ?
         WHERE id = ?`
      )
      .run(
        purpose === "reauthorize"
          ? "PENDING_REAUTHORIZATION"
          : "PENDING_AUTHORIZATION",
        JSON.stringify(
          (bank.required_psu_headers ?? []).map((header) =>
            header.toLowerCase()
          )
        ),
        connection.id
      );
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
    return await this.start(connection, bank, "connect");
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

  public async complete(input: {
    state?: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<AuthorizationCompletionResult> {
    if (!input.state) throw new AuthorizationDeniedError("El callback no contiene state.");
    const pending = this.states.consume(input.state);
    if (input.error || !input.code) {
      const message = (
        input.errorDescription ??
        (input.error ? "Autorización denegada." : "El callback no contiene code.")
      ).slice(0, 300);
      this.database
        .prepare(
          `UPDATE bank_connections SET
             status = ?, reauthorization_required = ?,
             error_code = ?, error_message_safe = ?
           WHERE id = ?`
        )
        .run(
          pending.purpose === "reauthorize" ? "REAUTHORIZATION_REQUIRED" : "DENIED",
          pending.purpose === "reauthorize" ? 1 : 0,
          input.error ?? "MISSING_AUTHORIZATION_CODE",
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
      const recoverySessions = this.database
        .prepare(
          `SELECT id, provider_session_id_ciphertext
           FROM provider_sessions
           WHERE bank_connection_id = ? AND status = 'REVOCATION_REQUIRED'`
        )
        .all(pending.bankConnectionId) as Array<{
          id: string;
          provider_session_id_ciphertext: string;
        }>;
      for (const recovery of recoverySessions) {
        try {
          await this.client.deleteSession(
            decryptSecret(
              recovery.provider_session_id_ciphertext,
              this.config.sessionEncryptionKey
            )
          );
          this.database
            .prepare("DELETE FROM provider_sessions WHERE id = ?")
            .run(recovery.id);
        } catch {
          // Retain the recovery row so a later retry or disconnect can revoke it.
        }
      }
      const raw = await this.rawStore.write("session", pending.bankConnectionId, session);
      const now = new Date().toISOString();
      const validUntil = session.access?.valid_until ?? null;
      const dbTransaction = this.database.transaction(() => {
        this.database
          .prepare(
            `UPDATE provider_sessions SET status = 'SUPERSEDED'
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
               reauthorization_required = 0, error_code = NULL,
               error_message_safe = NULL, retry_after_at = NULL,
               online_retry_used = 0
             WHERE id = ?`
          )
          .run(now, validUntil, pending.bankConnectionId);
        for (const account of session.accounts) {
          this.accounts.upsert(pending.bankConnectionId, account, raw.path);
        }
      });
      dbTransaction();
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
      this.database
        .prepare(
          `UPDATE bank_connections SET
             status = ?, reauthorization_required = ?,
             error_code = ?, error_message_safe = ?
           WHERE id = ?`
        )
        .run(
          pending.purpose === "reauthorize"
            ? "REAUTHORIZATION_REQUIRED"
            : "AUTHORIZATION_FAILED",
          pending.purpose === "reauthorize" ? 1 : 0,
          providerErrorCode(error) ??
            (error instanceof KakeboError ? error.code : "CALLBACK_ERROR"),
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
