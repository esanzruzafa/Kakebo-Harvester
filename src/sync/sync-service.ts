import type { AppConfig } from "../config.js";
import type {
  EnableBankingClient,
  PsuHeaders
} from "../enable-banking/client.js";
import {
  BankUnavailableError,
  EnableBankingProviderError,
  KakeboError,
  PsuHeadersUnavailableError,
  RateLimitError,
  ReauthorizationRequiredError,
  TransactionsPeriodError,
  providerErrorCode
} from "../errors.js";
import type { SqliteDatabase } from "../storage/database.js";
import { RawStore } from "../storage/raw-store.js";
import {
  AccountRepository,
  type StoredAccount
} from "../storage/repositories/account-repository.js";
import { Categorizer } from "../transactions/categorization.js";
import { TransactionRepository } from "../transactions/deduplication.js";
import { mapTransaction } from "../transactions/transaction-mapper.js";
import { createId, decryptSecret } from "../utils/crypto.js";
import { assertIsoDate } from "../utils/dates.js";
import { safeMessage } from "../utils/text.js";

interface ActiveSession {
  connection_id: string;
  session_ciphertext: string;
}

export type AccountFailureDecision = "continue" | "stop";
export type AccountSyncPhase = "accounts" | "balances" | "transactions";

export interface AccountSyncFailure {
  accountId: string | null;
  providerAccountId: string;
  accountName: string;
  masked: string | null;
  bankName: string;
  connectionName: string;
  phase: AccountSyncPhase;
  code: string;
  message: string;
}

export interface SyncExecutionContext {
  psuHeaders?: PsuHeaders;
  allowRateLimitOverride?: boolean;
  skippedAccountIds?: Set<string>;
  skippedConnectionIds?: Set<string>;
  skippedAuthorizationConnectionIds?: Set<string>;
  skippedRateLimitConnectionIds?: Set<string>;
  skippedUnavailableConnectionIds?: Set<string>;
  onAccountFailure?: (
    failure: AccountSyncFailure
  ) => Promise<AccountFailureDecision>;
}

interface ConnectionPsuRow {
  id: string;
  bank_name: string;
  bank_country: string;
  psu_type: "personal" | "business";
  required_psu_headers_json: string | null;
}

export interface SyncSummary {
  pages: number;
  received: number;
  inserted: number;
  updated: number;
  duplicates: number;
  pendingReconciled: number;
}

function emptySummary(): SyncSummary {
  return {
    pages: 0,
    received: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    pendingReconciled: 0
  };
}

function firstValidMovementDate(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    if (!value) {
      continue;
    }
    const candidate = value.slice(0, 10);
    try {
      return assertIsoDate(candidate, "provider movement date");
    } catch {
      // Try the next provider date before treating the movement as undated.
    }
  }
  return undefined;
}

export class SyncService {
  private readonly accounts: AccountRepository;
  private readonly transactions: TransactionRepository;
  private readonly rawStore: RawStore;
  private readonly categorizer: Categorizer;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: SqliteDatabase,
    private readonly client: EnableBankingClient
  ) {
    this.accounts = new AccountRepository(database);
    this.transactions = new TransactionRepository(
      database,
      config.pendingReconciliationWindowDays
    );
    this.rawStore = new RawStore(config);
    this.categorizer = new Categorizer(config.categorizationRulesPath);
  }

  public listConnectionsRequiringAuthorization(): string[] {
    const now = new Date().toISOString();
    const rows = this.database
      .prepare(
        `SELECT c.id
         FROM bank_connections c
         WHERE c.environment = @environment
           AND c.provider = 'enable-banking'
           AND c.status NOT IN ('REVOKED', 'DENIED')
           AND (
             c.status <> 'AUTHORIZED'
             OR c.reauthorization_required = 1
             OR (c.valid_until IS NOT NULL AND c.valid_until <= @now)
             OR NOT EXISTS (
               SELECT 1 FROM provider_sessions s
               WHERE s.bank_connection_id = c.id
                 AND s.status = 'AUTHORIZED'
                 AND (s.valid_until IS NULL OR s.valid_until > @now)
             )
           )
         ORDER BY c.created_at`
      )
      .all({ environment: this.config.appEnv, now }) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private async refreshMissingPsuMetadata(
    skippedConnectionIds?: Set<string>
  ): Promise<void> {
    const rows = (this.database
      .prepare(
        `SELECT id, bank_name, bank_country, psu_type,
                required_psu_headers_json
         FROM bank_connections
         WHERE provider = 'enable-banking'
           AND environment = ?
           AND status = 'AUTHORIZED'
           AND required_psu_headers_json IS NULL`
      )
      .all(this.config.appEnv) as ConnectionPsuRow[]).filter(
        (row) => !skippedConnectionIds?.has(row.id)
      );
    const catalogs = new Map<string, Awaited<ReturnType<EnableBankingClient["listBanks"]>>>();
    for (const row of rows) {
      const key = `${row.bank_country}:${row.psu_type}`;
      let banks = catalogs.get(key);
      if (!banks) {
        banks = await this.client.listBanks(row.bank_country, row.psu_type);
        catalogs.set(key, banks);
      }
      const bank = banks.find((candidate) => candidate.name === row.bank_name);
      if (!bank) continue;
      this.database
        .prepare(
          `UPDATE bank_connections
           SET required_psu_headers_json = ?
           WHERE id = ?`
        )
        .run(
          JSON.stringify(
            (bank.required_psu_headers ?? []).map((header) =>
              header.toLowerCase()
            )
          ),
          row.id
        );
    }
  }

  private connectionPsuHeaders(
    connectionId: string,
    context: SyncExecutionContext
  ): PsuHeaders | undefined {
    if (!context.psuHeaders) return undefined;
    const row = this.database
      .prepare(
        `SELECT id, bank_name, bank_country, psu_type,
                required_psu_headers_json
         FROM bank_connections WHERE id = ?`
      )
      .get(connectionId) as ConnectionPsuRow | undefined;
    if (!row || row.required_psu_headers_json === null) {
      throw new PsuHeadersUnavailableError([
        "required_psu_headers metadata"
      ]);
    }
    let required: unknown;
    try {
      required = JSON.parse(row.required_psu_headers_json) as unknown;
    } catch {
      throw new PsuHeadersUnavailableError([
        "required_psu_headers metadata"
      ]);
    }
    const requiredHeaders = Array.isArray(required)
      ? required.filter((value): value is string => typeof value === "string")
      : [];
    const available = new Set<string>();
    if (context.psuHeaders.ipAddress) available.add("psu-ip-address");
    if (context.psuHeaders.userAgent) available.add("psu-user-agent");
    if (context.psuHeaders.acceptLanguage) {
      available.add("psu-accept-language");
    }
    const missing = requiredHeaders.filter(
      (header) => !available.has(header.toLowerCase())
    );
    if (missing.length > 0) {
      throw new PsuHeadersUnavailableError(missing);
    }
    return context.psuHeaders;
  }

  private async assertConnectionsReady(
    context: SyncExecutionContext = {}
  ): Promise<void> {
    context.skippedConnectionIds ??= new Set<string>();
    context.skippedConnectionIds.clear();
    for (const connectionId of context.skippedUnavailableConnectionIds ?? []) {
      context.skippedConnectionIds.add(connectionId);
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE bank_connections
         SET retry_after_at = NULL,
             online_retry_used = 0,
             error_code = NULL,
             error_message_safe = NULL
         WHERE provider = 'enable-banking'
           AND environment = ?
           AND retry_after_at IS NOT NULL
           AND retry_after_at <= ?`
      )
      .run(this.config.appEnv, now);
    const limited = this.database
      .prepare(
        `SELECT id, retry_after_at, error_code, online_retry_used
         FROM bank_connections
         WHERE provider = 'enable-banking'
           AND environment = ?
           AND status = 'AUTHORIZED'
           AND retry_after_at > ?
         ORDER BY retry_after_at DESC`
      )
      .all(this.config.appEnv, now) as Array<{
        id: string;
        retry_after_at: string;
        error_code: string | null;
        online_retry_used: number;
      }>;
    context.skippedRateLimitConnectionIds ??= new Set<string>();
    const currentlyLimitedIds = new Set(limited.map((row) => row.id));
    for (const connectionId of context.skippedRateLimitConnectionIds) {
      if (!currentlyLimitedIds.has(connectionId)) {
        context.skippedRateLimitConnectionIds.delete(connectionId);
      }
    }
    if (limited.length > 0) {
      for (const row of limited) {
        const canTryOnline =
          context.allowRateLimitOverride === true &&
          context.psuHeaders !== undefined &&
          row.online_retry_used === 0;
        if (!canTryOnline) {
          context.skippedConnectionIds.add(row.id);
          context.skippedRateLimitConnectionIds.add(row.id);
        }
      }
    }
    const connectionIds = this.listConnectionsRequiringAuthorization();
    context.skippedAuthorizationConnectionIds ??= new Set<string>();
    const connectionsRequiringAuthorization = new Set(connectionIds);
    for (const connectionId of context.skippedAuthorizationConnectionIds) {
      if (!connectionsRequiringAuthorization.has(connectionId)) {
        context.skippedAuthorizationConnectionIds.delete(connectionId);
      }
    }
    if (connectionIds.length > 0) {
      for (const connectionId of connectionIds) {
        context.skippedConnectionIds.add(connectionId);
      }
      if (this.listSessions(context.skippedConnectionIds).length === 0) {
        throw new ReauthorizationRequiredError(
          "Una o más conexiones bancarias requieren autorización.",
          connectionIds
        );
      }
      for (const connectionId of connectionIds) {
        context.skippedAuthorizationConnectionIds.add(connectionId);
      }
    }
    if (
      limited.length > 0 &&
      this.listSessions(context.skippedConnectionIds).length === 0
    ) {
      const retryAt = limited[0]?.retry_after_at;
      throw new RateLimitError(
        `El banco ha alcanzado su límite de consultas. Próximo intento permitido: ${retryAt}. (${limited[0]?.error_code ?? "ASPSP_RATE_LIMIT_EXCEEDED"})`,
        retryAt,
        [...context.skippedConnectionIds],
        limited[0]?.error_code ?? "ASPSP_RATE_LIMIT_EXCEEDED"
      );
    }
    if (context.psuHeaders) {
      await this.refreshMissingPsuMetadata(context.skippedConnectionIds);
      const rows = this.database
        .prepare(
          `SELECT id FROM bank_connections
           WHERE provider = 'enable-banking'
             AND environment = ?
             AND status = 'AUTHORIZED'`
        )
        .all(this.config.appEnv) as Array<{ id: string }>;
      for (const row of rows) {
        if (!context.skippedConnectionIds.has(row.id)) {
          this.connectionPsuHeaders(row.id, context);
        }
      }
    }
  }

  private listSessions(skippedConnectionIds?: Set<string>): ActiveSession[] {
    const now = new Date().toISOString();
    const sessions = this.database
      .prepare(
        `SELECT c.id AS connection_id,
                s.provider_session_id_ciphertext AS session_ciphertext
         FROM bank_connections c
         JOIN provider_sessions s ON s.bank_connection_id = c.id
         WHERE c.provider = 'enable-banking'
         AND c.environment = ?
         AND c.status = 'AUTHORIZED'
         AND c.reauthorization_required = 0
         AND (c.valid_until IS NULL OR c.valid_until > ?)
         AND s.status = 'AUTHORIZED'
         AND (s.valid_until IS NULL OR s.valid_until > ?)
          AND s.id = (
            SELECT s2.id FROM provider_sessions s2
            WHERE s2.bank_connection_id = c.id
              AND s2.status = 'AUTHORIZED'
              AND (s2.valid_until IS NULL OR s2.valid_until > ?)
            ORDER BY s2.created_at DESC, s2.rowid DESC
            LIMIT 1
          )`
      )
      .all(this.config.appEnv, now, now, now) as ActiveSession[];
    return sessions.filter(
      (session) => !skippedConnectionIds?.has(session.connection_id)
    );
  }

  private markReauthorization(connectionId: string, error: unknown): void {
    this.database
      .prepare(
        `UPDATE bank_connections SET
           status = 'REAUTHORIZATION_REQUIRED', reauthorization_required = 1,
           error_code = 'REAUTHORIZATION_REQUIRED', error_message_safe = ?
         WHERE id = ?`
      )
      .run(safeMessage(error), connectionId);
  }

  private reauthorizationForConnections(
    error: ReauthorizationRequiredError,
    connectionIds: ReadonlySet<string>
  ): ReauthorizationRequiredError {
    return new ReauthorizationRequiredError(
      error.message,
      [...connectionIds],
      {
        ...(error.providerCode ? { providerCode: error.providerCode } : {}),
        ...(error.httpStatus ? { httpStatus: error.httpStatus } : {})
      }
    );
  }

  private markConnectionError(
    connectionId: string,
    error: unknown,
    context: SyncExecutionContext
  ): unknown {
    if (error instanceof ReauthorizationRequiredError) {
      this.markReauthorization(connectionId, error);
      return new ReauthorizationRequiredError(
        error.message,
        [connectionId],
        {
          ...(error.providerCode ? { providerCode: error.providerCode } : {}),
          ...(error.httpStatus ? { httpStatus: error.httpStatus } : {})
        }
      );
    }
    const code =
      providerErrorCode(error) ??
      (error instanceof KakeboError ? error.code : "SYNC_ERROR");
    if (error instanceof RateLimitError) {
      context.skippedRateLimitConnectionIds ??= new Set<string>();
      context.skippedRateLimitConnectionIds.add(connectionId);
      this.database
        .prepare(
          `UPDATE bank_connections SET
             retry_after_at = ?, error_code = ?, error_message_safe = ?,
             online_retry_used = ?
           WHERE id = ?`
        )
        .run(
          error.retryAt ?? null,
          code,
          safeMessage(error),
          context.allowRateLimitOverride === true ? 1 : 0,
          connectionId
        );
      return new RateLimitError(
        error.message,
        error.retryAt,
        [connectionId],
        error.providerCode
      );
    }
    this.database
      .prepare(
        `UPDATE bank_connections SET
           error_code = ?, error_message_safe = ?
         WHERE id = ?`
      )
      .run(code, safeMessage(error), connectionId);
    return error;
  }

  private clearConnectionError(connectionId: string): void {
    this.database
      .prepare(
        `UPDATE bank_connections SET
           error_code = NULL, error_message_safe = NULL, retry_after_at = NULL,
           online_retry_used = 0
         WHERE id = ?`
      )
      .run(connectionId);
  }

  private isRecoverableAccountFailure(error: unknown): boolean {
    return (
      error instanceof BankUnavailableError ||
      error instanceof EnableBankingProviderError
    );
  }

  private skipUnavailableConnection(
    connectionId: string,
    error: unknown,
    context: SyncExecutionContext
  ): boolean {
    if (!this.isRecoverableAccountFailure(error)) return false;
    context.skippedConnectionIds?.add(connectionId);
    context.skippedUnavailableConnectionIds ??= new Set<string>();
    context.skippedUnavailableConnectionIds.add(connectionId);
    return true;
  }

  private async handleAccountFailure(
    connectionId: string,
    providerAccountId: string,
    phase: AccountSyncPhase,
    error: unknown,
    context: SyncExecutionContext,
    knownAccount?: StoredAccount
  ): Promise<boolean> {
    if (!this.isRecoverableAccountFailure(error)) return false;
    const account =
      knownAccount ??
      this.accounts.findByProviderAccountId(connectionId, providerAccountId);
    const connection = this.database
      .prepare(
        `SELECT bank_name, alias FROM bank_connections WHERE id = ?`
      )
      .get(connectionId) as { bank_name: string; alias: string } | undefined;
    const code =
      providerErrorCode(error) ??
      (error instanceof KakeboError ? error.code : "SYNC_ERROR");
    const message = safeMessage(error);
    if (account) {
      this.accounts.recordLastSyncError(account.id, code, message);
      context.skippedAccountIds?.add(account.id);
    }
    const failure: AccountSyncFailure = {
      accountId: account?.id ?? null,
      providerAccountId,
      accountName:
        account?.account_alias ??
        account?.display_name ??
        account?.name ??
        `Account ${providerAccountId}`,
      masked: account?.iban_masked ?? null,
      bankName: account?.bank_name ?? connection?.bank_name ?? "Bank",
      connectionName: account?.connection_alias ?? connection?.alias ?? "Connection",
      phase,
      code,
      message
    };
    const decision = context.onAccountFailure
      ? await context.onAccountFailure(failure)
      : "stop";
    return decision === "continue";
  }

  public async syncAccounts(
    context: SyncExecutionContext = {}
  ): Promise<number> {
    await this.assertConnectionsReady(context);
    let count = 0;
    let completedConnections = 0;
    let deferredAuthorization: ReauthorizationRequiredError | undefined;
    const deferredAuthorizationConnectionIds = new Set<string>();
    let deferredRateLimit: RateLimitError | undefined;
    let deferredUnavailable: Error | undefined;
    for (const stored of this.listSessions(context.skippedConnectionIds)) {
      let sessionResolved = false;
      try {
        const sessionId = decryptSecret(
          stored.session_ciphertext,
          this.config.sessionEncryptionKey
        );
        const session = await this.client.getSession(sessionId);
        sessionResolved = true;
        if (session.status !== "AUTHORIZED") {
          throw new ReauthorizationRequiredError(`La sesión está en estado ${session.status}.`);
        }
        const sessionAccountIds = [...new Set(session.accounts)];
        this.accounts.reconcileProviderActiveSet(
          stored.connection_id,
          sessionAccountIds
        );
        for (const accountId of sessionAccountIds) {
          if (!this.accounts.shouldRefreshDetails(stored.connection_id, accountId)) {
            continue;
          }
          const knownAccount = this.accounts.findByProviderAccountId(
            stored.connection_id,
            accountId
          );
          if (knownAccount && context.skippedAccountIds?.has(knownAccount.id)) {
            continue;
          }
          try {
            const account = await this.client.getAccount(
              accountId,
              this.connectionPsuHeaders(stored.connection_id, context)
            );
            const raw = await this.rawStore.write("account", accountId, account);
            this.accounts.upsert(stored.connection_id, account, raw.path);
            count += 1;
          } catch (error) {
            if (
              await this.handleAccountFailure(
                stored.connection_id,
                accountId,
                "accounts",
                error,
                context,
                knownAccount
              )
            ) {
              continue;
            }
            throw error;
          }
        }
        this.clearConnectionError(stored.connection_id);
        completedConnections += 1;
      } catch (error) {
        const reported = this.markConnectionError(
          stored.connection_id,
          error,
          context
        );
        if (reported instanceof ReauthorizationRequiredError) {
          context.skippedConnectionIds?.add(stored.connection_id);
          context.skippedAuthorizationConnectionIds ??= new Set<string>();
          context.skippedAuthorizationConnectionIds.add(stored.connection_id);
          deferredAuthorization ??= reported;
          for (const connectionId of reported.connectionIds) {
            deferredAuthorizationConnectionIds.add(connectionId);
          }
          continue;
        }
        if (reported instanceof RateLimitError) {
          context.skippedConnectionIds?.add(stored.connection_id);
          deferredRateLimit ??= reported;
          continue;
        }
        if (
          !sessionResolved &&
          this.skipUnavailableConnection(
            stored.connection_id,
            reported,
            context
          )
        ) {
          deferredUnavailable ??=
            reported instanceof Error
              ? reported
              : new Error(safeMessage(reported));
          continue;
        }
        throw reported;
      }
    }
    if (deferredAuthorization && completedConnections === 0) {
      throw this.reauthorizationForConnections(
        deferredAuthorization,
        deferredAuthorizationConnectionIds
      );
    }
    if (deferredRateLimit && completedConnections === 0) throw deferredRateLimit;
    if (deferredUnavailable && completedConnections === 0) {
      throw deferredUnavailable;
    }
    return count;
  }

  public async syncBalances(
    desktopRunId?: string,
    context: SyncExecutionContext = {}
  ): Promise<number> {
    await this.assertConnectionsReady(context);
    let deferredAuthorization: ReauthorizationRequiredError | undefined;
    const deferredAuthorizationConnectionIds = new Set<string>();
    let deferredRateLimit: RateLimitError | undefined;
    const completedConnectionIds = new Set<string>();
    const snapshots: Array<{
      account: StoredAccount;
      response: Awaited<ReturnType<EnableBankingClient["getBalances"]>>;
      rawPath: string | null;
      extractedAt: string;
    }> = [];
    for (const account of this.accounts.listActive()) {
      if (context.skippedConnectionIds?.has(account.bank_connection_id)) continue;
      if (context.skippedAccountIds?.has(account.id)) continue;
      try {
        const response = await this.client.getBalances(
          account.provider_account_id,
          this.connectionPsuHeaders(account.bank_connection_id, context)
        );
        const raw = await this.rawStore.write("balances", account.id, response);
        snapshots.push({
          account,
          response,
          rawPath: raw.path,
          extractedAt: new Date().toISOString()
        });
        completedConnectionIds.add(account.bank_connection_id);
        this.accounts.clearLastSyncError(account.id);
      } catch (error) {
        if (
          await this.handleAccountFailure(
            account.bank_connection_id,
            account.provider_account_id,
            "balances",
            error,
            context,
            account
          )
        ) {
          continue;
        }
        const reported = this.markConnectionError(
          account.bank_connection_id,
          error,
          context
        );
        if (reported instanceof ReauthorizationRequiredError) {
          context.skippedConnectionIds?.add(account.bank_connection_id);
          context.skippedAuthorizationConnectionIds ??= new Set<string>();
          context.skippedAuthorizationConnectionIds.add(
            account.bank_connection_id
          );
          completedConnectionIds.delete(account.bank_connection_id);
          deferredAuthorization ??= reported;
          for (const connectionId of reported.connectionIds) {
            deferredAuthorizationConnectionIds.add(connectionId);
          }
          continue;
        }
        if (reported instanceof RateLimitError) {
          context.skippedConnectionIds?.add(account.bank_connection_id);
          completedConnectionIds.delete(account.bank_connection_id);
          deferredRateLimit ??= reported;
          continue;
        }
        throw reported;
      }
    }
    if (deferredAuthorization && completedConnectionIds.size === 0) {
      throw this.reauthorizationForConnections(
        deferredAuthorization,
        deferredAuthorizationConnectionIds
      );
    }
    if (deferredRateLimit && completedConnectionIds.size === 0) {
      throw deferredRateLimit;
    }
    const insert = this.database.prepare(
      `INSERT INTO balances (
         id, account_id, balance_type, name, amount, currency,
         reference_date, extracted_at, raw_response_path, desktop_run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let count = 0;
    const transaction = this.database.transaction(() => {
      for (const snapshot of snapshots) {
        if (!completedConnectionIds.has(snapshot.account.bank_connection_id)) {
          continue;
        }
        for (const balance of snapshot.response.balances) {
          insert.run(
            createId(),
            snapshot.account.id,
            balance.balance_type ?? null,
            balance.name ?? null,
            balance.balance_amount.amount,
            balance.balance_amount.currency,
            balance.reference_date ?? balance.last_change_date_time ?? null,
            snapshot.extractedAt,
            snapshot.rawPath,
            desktopRunId ?? null
          );
          count += 1;
        }
      }
    });
    transaction();
    for (const connectionId of new Set(
      snapshots.map((snapshot) => snapshot.account.bank_connection_id)
    )) {
      if (!context.skippedConnectionIds?.has(connectionId)) {
        this.clearConnectionError(connectionId);
      }
    }
    return count;
  }

  private async syncAccountTransactions(
    account: StoredAccount,
    dateFrom: string,
    dateTo: string,
    context: SyncExecutionContext
  ): Promise<SyncSummary> {
    const summary = emptySummary();
    const seenKeys = new Set<string>();
    const fallbackOccurrences = new Map<string, Set<number>>();
    let continuationKey: string | undefined;
    let page = 1;
    let strategy: "longest" | undefined;
    while (page <= this.config.maxTransactionPages) {
      let response;
      try {
        response = await this.client.getTransactions(
          account.provider_account_id,
          {
            dateFrom,
            ...(strategy ? { strategy } : { dateTo }),
            ...(continuationKey ? { continuationKey } : {})
          },
          this.connectionPsuHeaders(account.bank_connection_id, context)
        );
      } catch (error) {
        if (
          error instanceof TransactionsPeriodError &&
          strategy === undefined &&
          continuationKey === undefined
        ) {
          strategy = "longest";
          continue;
        }
        throw error;
      }
      const raw = await this.rawStore.write("transactions", account.id, response, String(page));
      this.database
        .prepare(
          `INSERT INTO transactions_raw (
             id, account_id, fetched_at, page_number, raw_response_path, raw_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(createId(), account.id, new Date().toISOString(), page, raw.path, raw.fingerprint);

      summary.pages += 1;
      const databaseTransaction = this.database.transaction(() => {
        for (const providerTransaction of response.transactions) {
          let normalized = mapTransaction({
            transaction: providerTransaction,
            account,
            environment: this.config.appEnv,
            rawPath: raw.path,
            fallbackOccurrence: 1
          });
          const movementDate = firstValidMovementDate(
            normalized.booking_date,
            normalized.transaction_datetime,
            normalized.value_date
          );
          if (
            !movementDate ||
            movementDate < dateFrom ||
            movementDate > dateTo
          ) {
            continue;
          }
          const fallbackTransaction = { ...providerTransaction };
          delete fallbackTransaction.entry_reference;
          delete fallbackTransaction.transaction_id;
          const fallbackIdentity = mapTransaction({
            transaction: fallbackTransaction,
            account,
            environment: this.config.appEnv,
            rawPath: raw.path,
            fallbackOccurrence: 1
          });
          const claimed = fallbackOccurrences.get(fallbackIdentity.movement_key) ?? new Set<number>();
          const resolution = this.transactions.resolveFallbackIdentity(
            normalized,
            fallbackIdentity,
            claimed
          );
          claimed.add(resolution.occurrence);
          fallbackOccurrences.set(fallbackIdentity.movement_key, claimed);
          normalized = mapTransaction({
            transaction: providerTransaction,
            account,
            environment: this.config.appEnv,
            rawPath: raw.path,
            fallbackOccurrence: resolution.occurrence
          });
          summary.received += 1;
          const category = this.categorizer.categorize(normalized.description_normalized);
          normalized.category_auto = category.category;
          normalized.subcategory_auto = category.subcategory;
          const outcome = this.transactions.upsert(normalized, {
            matchExistingFallback: resolution.matchExistingFallback
          });
          if (outcome === "inserted") summary.inserted += 1;
          if (outcome === "updated") summary.updated += 1;
          if (outcome === "duplicate") summary.duplicates += 1;
          if (outcome === "reconciled") summary.pendingReconciled += 1;
        }
      });
      databaseTransaction();

      const nextKey = response.continuation_key ?? undefined;
      if (!nextKey) return summary;
      if (seenKeys.has(nextKey)) {
        throw new Error("Enable Banking repitió continuation_key; paginación detenida.");
      }
      seenKeys.add(nextKey);
      continuationKey = nextKey;
      page += 1;
    }
    throw new Error(
      `Se alcanzó MAX_TRANSACTION_PAGES=${this.config.maxTransactionPages}; sincronización detenida.`
    );
  }

  public async syncTransactions(
    dateFrom: string,
    dateTo: string,
    context: SyncExecutionContext = {}
  ): Promise<SyncSummary> {
    await this.assertConnectionsReady(context);
    this.categorizer.reload();
    const total = emptySummary();
    let deferredAuthorization: ReauthorizationRequiredError | undefined;
    const deferredAuthorizationConnectionIds = new Set<string>();
    let deferredRateLimit: RateLimitError | undefined;
    const completedConnectionIds = new Set<string>();
    for (const account of this.accounts.listActive()) {
      if (context.skippedConnectionIds?.has(account.bank_connection_id)) continue;
      if (context.skippedAccountIds?.has(account.id)) continue;
      const runId = createId();
      const startedAt = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO sync_runs (
             id, started_at, status, bank_connection_id, account_id, date_from, date_to
           ) VALUES (?, ?, 'RUNNING', ?, ?, ?, ?)`
        )
        .run(runId, startedAt, account.bank_connection_id, account.id, dateFrom, dateTo);
      try {
        const summary = await this.syncAccountTransactions(
          account,
          dateFrom,
          dateTo,
          context
        );
        for (const key of Object.keys(total) as Array<keyof SyncSummary>) {
          total[key] += summary[key];
        }
        completedConnectionIds.add(account.bank_connection_id);
        this.database
          .prepare(
            `UPDATE sync_runs SET
               finished_at = ?, status = 'SUCCESS', pages = ?, received = ?,
               inserted = ?, updated = ?, duplicates = ?, pending_reconciled = ?
             WHERE id = ?`
          )
          .run(
            new Date().toISOString(),
            summary.pages,
            summary.received,
            summary.inserted,
            summary.updated,
            summary.duplicates,
            summary.pendingReconciled,
            runId
          );
      } catch (error) {
        const continueWithOtherAccounts = await this.handleAccountFailure(
          account.bank_connection_id,
          account.provider_account_id,
          "transactions",
          error,
          context,
          account
        );
        const reportedError = continueWithOtherAccounts
          ? error
          : this.markConnectionError(account.bank_connection_id, error, context);
        this.database
          .prepare(
            `UPDATE sync_runs SET
               finished_at = ?, status = 'FAILED', error_code = ?, error_message_safe = ?
             WHERE id = ?`
          )
          .run(
            new Date().toISOString(),
            providerErrorCode(reportedError) ??
              (reportedError instanceof KakeboError
                ? reportedError.code
                : "SYNC_ERROR"),
            safeMessage(reportedError),
            runId
        );
        if (continueWithOtherAccounts) continue;
        if (reportedError instanceof ReauthorizationRequiredError) {
          context.skippedConnectionIds?.add(account.bank_connection_id);
          context.skippedAuthorizationConnectionIds ??= new Set<string>();
          context.skippedAuthorizationConnectionIds.add(
            account.bank_connection_id
          );
          completedConnectionIds.delete(account.bank_connection_id);
          deferredAuthorization ??= reportedError;
          for (const connectionId of reportedError.connectionIds) {
            deferredAuthorizationConnectionIds.add(connectionId);
          }
          continue;
        }
        if (reportedError instanceof RateLimitError) {
          context.skippedConnectionIds?.add(account.bank_connection_id);
          completedConnectionIds.delete(account.bank_connection_id);
          deferredRateLimit ??= reportedError;
          continue;
        }
        throw reportedError;
      }
      this.accounts.clearLastSyncError(account.id);
      this.clearConnectionError(account.bank_connection_id);
    }
    if (deferredAuthorization && completedConnectionIds.size === 0) {
      throw this.reauthorizationForConnections(
        deferredAuthorization,
        deferredAuthorizationConnectionIds
      );
    }
    if (deferredRateLimit && completedConnectionIds.size === 0) {
      throw deferredRateLimit;
    }
    const successfulConnectionIds = [...completedConnectionIds];
    if (successfulConnectionIds.length > 0) {
      this.database
        .prepare(
          `UPDATE bank_connections SET last_sync_at = ?
           WHERE provider = 'enable-banking'
             AND environment = ?
             AND status = 'AUTHORIZED'
             AND id IN (${successfulConnectionIds.map(() => "?").join(", ")})`
        )
        .run(
          new Date().toISOString(),
          this.config.appEnv,
          ...successfulConnectionIds
        );
    }
    return total;
  }

  public recategorizeTransactions(): number {
    this.categorizer.reload();
    const rows = this.database
      .prepare(
        `SELECT id, description_normalized
         FROM transactions
         WHERE reviewed = 0`
      )
      .all() as Array<{ id: string; description_normalized: string | null }>;
    const update = this.database.prepare(
      `UPDATE transactions SET category_auto = ?, subcategory_auto = ?
       WHERE id = ? AND reviewed = 0`
    );
    const transaction = this.database.transaction(() => {
      for (const row of rows) {
        const category = this.categorizer.categorize(row.description_normalized ?? "");
        update.run(category.category, category.subcategory, row.id);
      }
    });
    transaction();
    return rows.length;
  }
}
