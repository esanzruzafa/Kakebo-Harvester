import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeLocalAccount } from "../../src/storage/account-removal.js";
import { createDatabase, type SqliteDatabase } from "../../src/storage/database.js";
import { AccountRepository } from "../../src/storage/repositories/account-repository.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function insertConnection(database: SqliteDatabase, id: string, environment: string): void {
  database
    .prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?, 'AUTHORIZED', ?)`
    )
    .run(id, environment, `${id} bank`, `${id} alias`, new Date().toISOString());
}

function insertAccount(database: SqliteDatabase, id: string, connectionId: string): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
    .run(id, connectionId, `${id}-provider`, `${id} account`, now, now);
}

function insertHistory(database: SqliteDatabase, accountId: string): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO balances (id, account_id, amount, currency, extracted_at)
       VALUES (?, ?, '10', 'EUR', ?)`
    )
    .run(`${accountId}-balance`, accountId, now);
  database
    .prepare(
      `INSERT INTO transactions_raw (id, account_id, fetched_at, page_number, raw_fingerprint)
       VALUES (?, ?, ?, 1, ?)`
    )
    .run(`${accountId}-raw`, accountId, now, `${accountId}-raw-fingerprint`);
  database
    .prepare(
      `INSERT INTO transactions (
         id, movement_key, reconciliation_key, provider, environment, bank_connection_id,
         account_id, status, amount, currency, direction, first_seen_at, last_seen_at,
         imported_at, raw_fingerprint
       ) VALUES (?, ?, ?, 'enable-banking', 'sandbox', 'sandbox-connection', ?,
                 'BOOK', '10', 'EUR', 'credit', ?, ?, ?, ?)`
    )
    .run(
      `${accountId}-transaction`,
      `${accountId}-movement`,
      `${accountId}-reconciliation`,
      accountId,
      now,
      now,
      now,
      `${accountId}-transaction-fingerprint`
    );
  database
    .prepare(
      `INSERT INTO sync_runs (id, started_at, status, account_id)
       VALUES (?, ?, 'SUCCESS', ?)`
    )
    .run(`${accountId}-sync`, now, accountId);
}

function insertRawTransaction(
  database: SqliteDatabase,
  accountId: string,
  path: string
): void {
  database
    .prepare(
      `UPDATE transactions_raw SET raw_response_path = ? WHERE account_id = ?`
    )
    .run(path, accountId);
}

describe("local account removal persistence", () => {
  it("hides retained history, disables it, and restores visibility on provider rediscovery", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "account", "sandbox-connection");
    insertHistory(database, "account");

    await expect(
      removeLocalAccount({ database, environment: "sandbox", accountId: "account", mode: "keep-history" })
    ).resolves.toMatchObject({ status: "hidden", counts: { accounts: 0, balances: 0, transactions: 0, transactionsRaw: 0, synchronizationRuns: 0 } });
    expect(new AccountRepository(database).listEditable()).toEqual([]);
    expect(database.prepare("SELECT hidden, sync_enabled, export_enabled FROM accounts WHERE id = 'account'").get()).toEqual({ hidden: 1, sync_enabled: 0, export_enabled: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = 'account'").get()).toEqual({ count: 1 });

    new AccountRepository(database).upsert(
      "sandbox-connection",
      { uid: "account-provider", name: "Rediscovered account" },
      null
    );
    expect(new AccountRepository(database).listEditable().map((account) => account.id)).toEqual(["account"]);
    expect(database.prepare("SELECT hidden, sync_enabled, export_enabled FROM accounts WHERE id = 'account'").get()).toEqual({ hidden: 0, sync_enabled: 0, export_enabled: 0 });
    database.close();
  });

  it("purges only the selected account and its account-scoped records", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "selected", "sandbox-connection");
    insertAccount(database, "sibling", "sandbox-connection");
    insertHistory(database, "selected");
    insertHistory(database, "sibling");

    await expect(
      removeLocalAccount({ database, environment: "sandbox", accountId: "selected", mode: "delete-history" })
    ).resolves.toMatchObject({ status: "deleted", counts: { accounts: 1, balances: 1, transactions: 1, transactionsRaw: 1, synchronizationRuns: 1 } });
    for (const table of ["accounts", "balances", "transactions_raw", "transactions", "sync_runs"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "accounts" ? "id" : "account_id"} = 'selected'`).get()).toEqual({ count: 0 });
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "accounts" ? "id" : "account_id"} = 'sibling'`).get()).toEqual({ count: 1 });
    }
    database.close();
  });

  it("does not remove an account outside the active environment", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "production-connection", "production");
    insertAccount(database, "production-account", "production-connection");

    await expect(
      removeLocalAccount({ database, environment: "sandbox", accountId: "production-account", mode: "delete-history" })
    ).rejects.toThrow("The account does not exist in the active environment.");
    expect(database.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = 'production-account'").get()).toEqual({ count: 1 });
    database.close();
  });

  it("rolls back every constrained deletion when one account-scoped delete fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "account", "sandbox-connection");
    insertHistory(database, "account");
    database.exec(
      `CREATE TRIGGER fail_selected_transaction_delete
       BEFORE DELETE ON transactions
       WHEN OLD.account_id = 'account'
       BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END;`
    );

    await expect(
      removeLocalAccount({ database, environment: "sandbox", accountId: "account", mode: "delete-history" })
    ).rejects.toThrow("forced delete failure");
    for (const table of ["accounts", "balances", "transactions_raw", "transactions", "sync_runs"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === "accounts" ? "id" : "account_id"} = 'account'`).get()).toEqual({ count: 1 });
    }
    database.close();
  });

  it("removes a directly-owned raw file after a destructive purge", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "selected", "sandbox-connection");
    insertHistory(database, "selected");
    await mkdir(config.rawDataDirectory, { recursive: true });
    const rawPath = join(config.rawDataDirectory, "selected.json");
    await writeFile(rawPath, "{}\n");
    insertRawTransaction(database, "selected", rawPath);

    await expect(
      removeLocalAccount({
        database,
        environment: "sandbox",
        accountId: "selected",
        mode: "delete-history",
        rawDataDirectory: config.rawDataDirectory
      })
    ).resolves.toMatchObject({
      status: "deleted",
      rawCleanup: { removed: 1, warnings: [] },
      audit: { action: "local-account-removal", outcome: "deleted" }
    });
    await expect(writeFile(rawPath, "{}\n", { flag: "wx" })).resolves.toBeUndefined();
    database.close();
  });

  it("retains shared and outside raw paths as safe cleanup warnings", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "selected", "sandbox-connection");
    insertAccount(database, "sibling", "sandbox-connection");
    insertHistory(database, "selected");
    insertHistory(database, "sibling");
    await mkdir(config.rawDataDirectory, { recursive: true });
    const sharedPath = join(config.rawDataDirectory, "shared.json");
    const outsidePath = join(root, "outside.json");
    await writeFile(sharedPath, "{}\n");
    await writeFile(outsidePath, "{}\n");
    insertRawTransaction(database, "selected", sharedPath);
    database.prepare("UPDATE transactions_raw SET raw_response_path = ? WHERE account_id = ?").run(sharedPath, "sibling");
    database.prepare("INSERT INTO transactions_raw (id, account_id, fetched_at, page_number, raw_response_path, raw_fingerprint) VALUES ('outside', 'selected', ?, 2, ?, 'outside-fingerprint')").run(new Date().toISOString(), outsidePath);

    await expect(
      removeLocalAccount({
        database,
        environment: "sandbox",
        accountId: "selected",
        mode: "delete-history",
        rawDataDirectory: config.rawDataDirectory
      })
    ).resolves.toMatchObject({
      rawCleanup: { removed: 0, warnings: ["shared", "outside-root"] }
    });
    await expect(writeFile(sharedPath, "{}\n", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(writeFile(outsidePath, "{}\n", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
    database.close();
  });
});
