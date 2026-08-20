import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { BankUnavailableError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SyncRunner } from "../../src/sync/sync-runner.js";
import type { SyncProgressEvent } from "../../src/sync/sync-runner.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { encryptSecret } from "../../src/utils/crypto.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("account detail synchronization selection", () => {
  it("skips known disabled accounts but still discovers new accounts", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-accounts-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', ?, 'BBVA', 'ES', 'personal',
                   'BBVA personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("provider-session", config.sessionEncryptionKey), now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name, sync_enabled,
           active, first_seen_at, last_seen_at
         ) VALUES ('closed-account', 'connection', 'closed-provider-account',
                   'Closed account', 0, 1, ?, ?)`
      )
      .run(now, now);

    const getAccount = vi.fn().mockResolvedValue({
      uid: "new-provider-account",
      name: "New account",
      currency: "EUR"
    });
    const client = {
      getSession: vi.fn().mockResolvedValue({
        status: "AUTHORIZED",
        accounts: ["closed-provider-account", "new-provider-account"]
      }),
      getAccount
    } as unknown as EnableBankingClient;

    await expect(new SyncService(config, database, client).syncAccounts()).resolves.toBe(1);
    expect(getAccount).toHaveBeenCalledTimes(1);
    expect(getAccount).toHaveBeenCalledWith("new-provider-account", undefined);
    expect(
      database
        .prepare("SELECT sync_enabled FROM accounts WHERE id = 'closed-account'")
        .get()
    ).toEqual({ sync_enabled: 0 });
    database.close();
  });

  it("records an enabled account failure and skips it after the user continues", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-failure-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', ?, 'BBVA', 'ES', 'personal',
                   'BBVA personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("provider-session", config.sessionEncryptionKey), now);
    const insertAccount = database.prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name, sync_enabled,
         active, first_seen_at, last_seen_at
       ) VALUES (?, 'connection', ?, ?, 1, 1, ?, ?)`
    );
    insertAccount.run("closed-account", "closed-provider-account", "Closed account", now, now);
    insertAccount.run("healthy-account", "healthy-provider-account", "Healthy account", now, now);

    const getAccount = vi.fn((accountId: string) => {
      if (accountId === "closed-provider-account") {
        throw new BankUnavailableError(
          "The bank no longer provides this account.",
          undefined,
          { providerCode: "ASPSP_ERROR", httpStatus: 400 }
        );
      }
      return { uid: accountId, name: "Healthy account", currency: "EUR" };
    });
    const getBalances = vi.fn().mockResolvedValue({ balances: [] });
    const getTransactions = vi.fn().mockResolvedValue({
      transactions: [],
      continuation_key: null
    });
    const client = {
      getSession: vi.fn().mockResolvedValue({
        status: "AUTHORIZED",
        accounts: ["closed-provider-account", "healthy-provider-account"]
      }),
      getAccount,
      getBalances,
      getTransactions
    } as unknown as EnableBankingClient;
    const onAccountFailure = vi.fn().mockResolvedValue("continue");
    const service = new SyncService(config, database, client);
    const progressEvents: SyncProgressEvent[] = [];
    const onProgress = (event: SyncProgressEvent): void => {
      progressEvents.push(event);
    };

    await expect(
      new SyncRunner(config, database, service).run(
        {
          steps: ["accounts", "balances", "transactions"],
          dateFrom: "2026-08-01",
          dateTo: "2026-08-20"
        },
        { onAccountFailure, onProgress }
      )
    ).resolves.toMatchObject({
      accounts: 1,
      balances: 0,
      transactions: { received: 0 }
    });

    expect(getAccount).toHaveBeenCalledTimes(2);
    expect(getBalances).toHaveBeenCalledTimes(1);
    expect(getTransactions).toHaveBeenCalledTimes(1);
    expect(onAccountFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "closed-account",
        accountName: "Closed account",
        bankName: "BBVA",
        phase: "accounts",
        code: "ASPSP_ERROR"
      })
    );
    const accountFailureProgress = progressEvents.find(
      (event) => event.type === "account-failed"
    );
    expect(accountFailureProgress?.accountFailure?.accountId).toBe("closed-account");
    const lastError = database
      .prepare<
        [],
        { last_error_code: string; last_error_message_safe: string }
      >(
        `SELECT last_error_code, last_error_message_safe
         FROM accounts WHERE id = 'closed-account'`
      )
      .get();
    expect(lastError).toEqual({
      last_error_code: "ASPSP_ERROR",
      last_error_message_safe: "The bank no longer provides this account."
    });
    database.close();
  });
});
