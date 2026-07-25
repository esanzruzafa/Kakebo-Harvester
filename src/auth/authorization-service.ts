import type { AppConfig, PsuType } from "../config.js";
import type { EnableBankingClient } from "../enable-banking/client.js";
import type { SqliteDatabase } from "../storage/database.js";
import { RawStore } from "../storage/raw-store.js";
import { AccountRepository } from "../storage/repositories/account-repository.js";
import { createAuthorizationState, createId, encryptSecret } from "../utils/crypto.js";
import { AuthorizationDeniedError, KakeboError } from "../errors.js";
import { safeMessage } from "../utils/text.js";
import { StateStore } from "./state-store.js";

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

  public async connect(input: {
    bankSearch: string;
    country: string;
    psuType: PsuType;
  }): Promise<{ url: string; connectionAlias: string }> {
    const banks = await this.client.listBanks(input.country, input.psuType);
    const needle = input.bankSearch.toLocaleLowerCase();
    const exact = banks.find((bank) => bank.name.toLocaleLowerCase() === needle);
    const candidates = exact
      ? [exact]
      : banks.filter((bank) => bank.name.toLocaleLowerCase().includes(needle));
    if (candidates.length !== 1) {
      const names = candidates.slice(0, 10).map((bank) => bank.name).join(", ");
      throw new Error(
        candidates.length === 0
          ? `No se encontró "${input.bankSearch}" en ${input.country}.`
          : `La búsqueda es ambigua. Coincidencias: ${names}`
      );
    }
    const bank = candidates[0];
    if (!bank) throw new Error("No bank selected.");

    const connectionId = createId();
    const connectionAlias = `${bank.name} ${input.psuType}`;
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES (?, 'enable-banking', ?, ?, ?, ?, ?, 'PENDING_AUTHORIZATION', ?)`
      )
      .run(
        connectionId,
        this.config.appEnv,
        bank.name,
        bank.country,
        input.psuType,
        connectionAlias,
        now
      );

    const state = createAuthorizationState();
    this.states.save(state, {
      bankConnectionId: connectionId,
      bankName: bank.name,
      redirectUrl: this.config.redirectUrl,
      environment: this.config.appEnv
    });

    const authorization = await this.client.startAuthorization({
      bank,
      state,
      redirectUrl: this.config.redirectUrl,
      psuType: input.psuType,
      language: this.config.defaultLanguage
    });
    return { url: authorization.url, connectionAlias };
  }

  public async complete(input: {
    state?: string;
    code?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<void> {
    if (!input.state) throw new AuthorizationDeniedError("El callback no contiene state.");
    const pending = this.states.consume(input.state);
    if (input.error) {
      this.database
        .prepare(
          `UPDATE bank_connections
           SET status = 'DENIED', error_code = ?, error_message_safe = ?
           WHERE id = ?`
        )
        .run(
          input.error,
          (input.errorDescription ?? "Autorización denegada.").slice(0, 300),
          pending.bankConnectionId
        );
      throw new AuthorizationDeniedError();
    }
    if (!input.code) throw new AuthorizationDeniedError("El callback no contiene code.");

    try {
      const session = await this.client.authorizeSession(input.code);
      const raw = await this.rawStore.write("session", pending.bankConnectionId, session);
      const now = new Date().toISOString();
      const validUntil = session.access?.valid_until ?? null;
      const dbTransaction = this.database.transaction(() => {
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
               reauthorization_required = 0, error_code = NULL, error_message_safe = NULL
             WHERE id = ?`
          )
          .run(now, validUntil, pending.bankConnectionId);
        for (const account of session.accounts) {
          this.accounts.upsert(pending.bankConnectionId, account, raw.path);
        }
      });
      dbTransaction();
    } catch (error) {
      this.database
        .prepare(
          `UPDATE bank_connections SET
             status = 'AUTHORIZATION_FAILED', error_code = ?, error_message_safe = ?
           WHERE id = ?`
        )
        .run(
          error instanceof KakeboError ? error.code : "CALLBACK_ERROR",
          safeMessage(error),
          pending.bankConnectionId
        );
      throw error;
    }
  }
}
