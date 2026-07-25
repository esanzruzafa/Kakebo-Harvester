import type { AppConfig } from "../config.js";
import type { EnableBankingClient } from "../enable-banking/client.js";
import { ReauthorizationRequiredError } from "../errors.js";
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
import { safeMessage } from "../utils/text.js";

interface ActiveSession {
  connection_id: string;
  session_ciphertext: string;
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

export class SyncService {
  private readonly accounts: AccountRepository;
  private readonly transactions: TransactionRepository;
  private readonly rawStore: RawStore;
  private readonly categorizer = new Categorizer();

  public constructor(
    private readonly config: AppConfig,
    private readonly database: SqliteDatabase,
    private readonly client: EnableBankingClient
  ) {
    this.accounts = new AccountRepository(database);
    this.transactions = new TransactionRepository(database);
    this.rawStore = new RawStore(config);
  }

  private listSessions(): ActiveSession[] {
    return this.database
      .prepare(
        `SELECT c.id AS connection_id,
                s.provider_session_id_ciphertext AS session_ciphertext
         FROM bank_connections c
         JOIN provider_sessions s ON s.bank_connection_id = c.id
         WHERE c.status = 'AUTHORIZED' AND s.status = 'AUTHORIZED'
         AND s.created_at = (
           SELECT MAX(s2.created_at) FROM provider_sessions s2
           WHERE s2.bank_connection_id = c.id AND s2.status = 'AUTHORIZED'
         )`
      )
      .all() as ActiveSession[];
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

  public async syncAccounts(): Promise<number> {
    let count = 0;
    for (const stored of this.listSessions()) {
      try {
        const sessionId = decryptSecret(
          stored.session_ciphertext,
          this.config.sessionEncryptionKey
        );
        const session = await this.client.getSession(sessionId);
        if (session.status !== "AUTHORIZED") {
          throw new ReauthorizationRequiredError(`La sesión está en estado ${session.status}.`);
        }
        for (const accountId of session.accounts) {
          const account = await this.client.getAccount(accountId);
          const raw = await this.rawStore.write("account", accountId, account);
          this.accounts.upsert(stored.connection_id, account, raw.path);
          count += 1;
        }
      } catch (error) {
        if (error instanceof ReauthorizationRequiredError) {
          this.markReauthorization(stored.connection_id, error);
        }
        throw error;
      }
    }
    return count;
  }

  public async syncBalances(): Promise<number> {
    let count = 0;
    for (const account of this.accounts.listActive()) {
      try {
        const response = await this.client.getBalances(account.provider_account_id);
        const raw = await this.rawStore.write("balances", account.id, response);
        const extractedAt = new Date().toISOString();
        const insert = this.database.prepare(
          `INSERT INTO balances (
             id, account_id, balance_type, name, amount, currency,
             reference_date, extracted_at, raw_response_path
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const transaction = this.database.transaction(() => {
          for (const balance of response.balances) {
            insert.run(
              createId(),
              account.id,
              balance.balance_type ?? null,
              balance.name ?? null,
              balance.balance_amount.amount,
              balance.balance_amount.currency,
              balance.reference_date ?? balance.last_change_date_time ?? null,
              extractedAt,
              raw.path
            );
            count += 1;
          }
        });
        transaction();
      } catch (error) {
        if (error instanceof ReauthorizationRequiredError) {
          this.markReauthorization(account.bank_connection_id, error);
        }
        throw error;
      }
    }
    return count;
  }

  private async syncAccountTransactions(
    account: StoredAccount,
    dateFrom: string,
    dateTo: string
  ): Promise<SyncSummary> {
    const summary = emptySummary();
    const seenKeys = new Set<string>();
    let continuationKey: string | undefined;
    for (let page = 1; page <= this.config.maxTransactionPages; page += 1) {
      const response = await this.client.getTransactions(account.provider_account_id, {
        dateFrom,
        dateTo,
        ...(continuationKey ? { continuationKey } : {})
      });
      const raw = await this.rawStore.write("transactions", account.id, response, String(page));
      this.database
        .prepare(
          `INSERT INTO transactions_raw (
             id, account_id, fetched_at, page_number, raw_response_path, raw_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(createId(), account.id, new Date().toISOString(), page, raw.path, raw.fingerprint);

      summary.pages += 1;
      summary.received += response.transactions.length;
      const databaseTransaction = this.database.transaction(() => {
        for (const providerTransaction of response.transactions) {
          const normalized = mapTransaction({
            transaction: providerTransaction,
            account,
            environment: this.config.appEnv,
            rawPath: raw.path
          });
          const category = this.categorizer.categorize(normalized.description_normalized);
          normalized.category_auto = category.category;
          normalized.subcategory_auto = category.subcategory;
          const outcome = this.transactions.upsert(normalized);
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
    }
    throw new Error(
      `Se alcanzó MAX_TRANSACTION_PAGES=${this.config.maxTransactionPages}; sincronización detenida.`
    );
  }

  public async syncTransactions(
    dateFrom: string,
    dateTo: string
  ): Promise<SyncSummary> {
    const total = emptySummary();
    for (const account of this.accounts.listActive()) {
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
        const summary = await this.syncAccountTransactions(account, dateFrom, dateTo);
        for (const key of Object.keys(total) as Array<keyof SyncSummary>) {
          total[key] += summary[key];
        }
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
        if (error instanceof ReauthorizationRequiredError) {
          this.markReauthorization(account.bank_connection_id, error);
        }
        this.database
          .prepare(
            `UPDATE sync_runs SET
               finished_at = ?, status = 'FAILED', error_code = ?, error_message_safe = ?
             WHERE id = ?`
          )
          .run(new Date().toISOString(), "SYNC_ERROR", safeMessage(error), runId);
        throw error;
      }
    }
    this.database
      .prepare(
        `UPDATE bank_connections SET last_sync_at = ?
         WHERE status = 'AUTHORIZED'`
      )
      .run(new Date().toISOString());
    return total;
  }
}
