import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { ReauthorizationRequiredError } from "../../src/errors.js";
import { createDatabase, type SqliteDatabase } from "../../src/storage/database.js";
import { SyncService, type SyncExecutionContext } from "../../src/sync/sync-service.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function insertConnectionWithAccount(
  database: SqliteDatabase,
  environment: string,
  input: { connectionId: string; bankName: string; accountId: string }
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?,
                 'AUTHORIZED', ?)`
    )
    .run(
      input.connectionId,
      environment,
      input.bankName,
      `${input.bankName} personal`,
      now
    );
  database
    .prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext,
         created_at, status
       ) VALUES (?, ?, 'ciphertext', ?, 'AUTHORIZED')`
    )
    .run(`${input.connectionId}-session`, input.connectionId, now);
  database
    .prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name,
         active, sync_enabled, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
    )
    .run(
      input.accountId,
      input.connectionId,
      `${input.accountId}-provider`,
      input.accountId,
      now,
      now
    );
}

async function setupTwoBanks(): Promise<{
  database: SqliteDatabase;
  config: ReturnType<typeof testConfig>;
}> {
  root = await mkdtemp(join(tmpdir(), "kakebo-runtime-reauthorization-"));
  const config = testConfig(root);
  const database = createDatabase(config.databasePath);
  insertConnectionWithAccount(database, config.appEnv, {
    connectionId: "expired-connection",
    bankName: "A Expired Bank",
    accountId: "expired-account"
  });
  insertConnectionWithAccount(database, config.appEnv, {
    connectionId: "healthy-connection",
    bankName: "B Healthy Bank",
    accountId: "healthy-account"
  });
  return { database, config };
}

describe("runtime reauthorization isolation", () => {
  it("skips an expired bank during balances and persists only complete connections", async () => {
    const { database, config } = await setupTwoBanks();
    const getBalances = vi.fn((providerAccountId: string) => {
      if (providerAccountId === "expired-account-provider") {
        throw new ReauthorizationRequiredError("The bank session expired.");
      }
      return {
        balances: [
          {
            balance_amount: { amount: "125.00", currency: "EUR" },
            balance_type: "CLBD"
          }
        ]
      };
    });
    const context: SyncExecutionContext = {};

    await expect(
      new SyncService(
        config,
        database,
        { getBalances } as unknown as EnableBankingClient
      ).syncBalances(undefined, context)
    ).resolves.toBe(1);

    expect(getBalances).toHaveBeenCalledTimes(2);
    expect([...context.skippedAuthorizationConnectionIds ?? []]).toEqual([
      "expired-connection"
    ]);
    expect(
      database
        .prepare(
          `SELECT a.id AS account_id
           FROM balances b JOIN accounts a ON a.id = b.account_id`
        )
        .all()
    ).toEqual([{ account_id: "healthy-account" }]);
    database.close();
  });

  it("skips an expired bank during transactions and completes the other bank", async () => {
    const { database, config } = await setupTwoBanks();
    const getTransactions = vi.fn((providerAccountId: string) => {
      if (providerAccountId === "expired-account-provider") {
        throw new ReauthorizationRequiredError("The bank session expired.");
      }
      return { transactions: [], continuation_key: null };
    });
    const context: SyncExecutionContext = {};

    await expect(
      new SyncService(
        config,
        database,
        { getTransactions } as unknown as EnableBankingClient
      ).syncTransactions("2026-08-01", "2026-08-20", context)
    ).resolves.toMatchObject({ pages: 1, received: 0 });

    expect(getTransactions).toHaveBeenCalledTimes(2);
    expect([...context.skippedAuthorizationConnectionIds ?? []]).toEqual([
      "expired-connection"
    ]);
    expect(
      database
        .prepare(
          `SELECT bank_connection_id, status
           FROM sync_runs ORDER BY bank_connection_id`
        )
        .all()
    ).toEqual([
      { bank_connection_id: "expired-connection", status: "FAILED" },
      { bank_connection_id: "healthy-connection", status: "SUCCESS" }
    ]);
    database.close();
  });
});
