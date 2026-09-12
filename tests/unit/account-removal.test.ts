import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLocalAccountRemoval,
  cleanupRawFiles,
  removeLocalAccount
} from "../../src/storage/account-removal.js";
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

  it("removes a directly-owned raw file in the RawStore hierarchy", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "selected", "sandbox-connection");
    insertHistory(database, "selected");
    const rawPath = join(config.rawDataDirectory, "2026-09-13", "selected", "transactions.json");
    await mkdir(join(config.rawDataDirectory, "2026-09-13", "selected"), { recursive: true });
    await writeFile(rawPath, "{}\n");
    insertRawTransaction(database, "selected", rawPath);

    await expect(removeLocalAccount({
      database,
      environment: "sandbox",
      accountId: "selected",
      mode: "delete-history",
      rawDataDirectory: config.rawDataDirectory
    })).resolves.toMatchObject({ rawCleanup: { removed: 1, warnings: [] } });
    await expect(writeFile(rawPath, "{}\n", { flag: "wx" })).resolves.toBeUndefined();
    database.close();
  });

  it("persists a privacy-safe local removal audit event without account or financial data", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-audit-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "selected", "sandbox-connection");
    insertHistory(database, "selected");

    await removeLocalAccount({ database, environment: "sandbox", accountId: "selected", mode: "delete-history" });

    const event = database.prepare(
      "SELECT action, outcome, occurred_at FROM local_account_removal_audit_events"
    ).get() as Record<string, unknown>;
    expect(event).toMatchObject({ action: "local-account-removal", outcome: "deleted" });
    expect(Object.keys(event).sort()).toEqual(["action", "occurred_at", "outcome"]);
    database.close();
  });

  it("retains a raw file that is still referenced by a provider session", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "selected", "sandbox-connection");
    await mkdir(config.rawDataDirectory, { recursive: true });
    const rawPath = join(config.rawDataDirectory, "session.json");
    await writeFile(rawPath, "{}\n");
    database.prepare("UPDATE accounts SET raw_response_path = ? WHERE id = 'selected'").run(rawPath);
    database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext, created_at, status, raw_response_path
       ) VALUES ('session', 'sandbox-connection', 'ciphertext', ?, 'AUTHORIZED', ?)`
    ).run(new Date().toISOString(), rawPath);

    await expect(removeLocalAccount({
      database,
      environment: "sandbox",
      accountId: "selected",
      mode: "delete-history",
      rawDataDirectory: config.rawDataDirectory
    })).resolves.toMatchObject({ rawCleanup: { removed: 0, warnings: ["shared"] } });
    await expect(writeFile(rawPath, "{}\n", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
    database.close();
  });

  it("removes manual-card source mappings with the selected local account", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type, alias, status, created_at
       ) VALUES ('manual-connection', 'manual-card', 'sandbox', 'Card bank', 'ES', 'personal', 'Card', 'LOCAL', ?)`
    ).run(now);
    database.prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
       ) VALUES ('manual-account', 'manual-connection', 'profile-selected', 'Selected card', 1, ?, ?)`
    ).run(now, now);
    database.prepare(
      `INSERT INTO card_import_source_rows (
         profile_id, source_path_hash, semantic_key_hash, occurrence,
         provider_transaction_id, first_seen_at, last_seen_at
       ) VALUES ('profile-selected', 'path', 'semantic', 1, 'transaction', ?, ?)`
    ).run(now, now);
    database.prepare(
      `INSERT INTO card_import_source_rows (
         profile_id, source_path_hash, semantic_key_hash, occurrence,
         provider_transaction_id, first_seen_at, last_seen_at
       ) VALUES ('profile-other', 'path', 'semantic', 1, 'transaction', ?, ?)`
    ).run(now, now);

    await removeLocalAccount({
      database,
      environment: "sandbox",
      accountId: "manual-account",
      mode: "delete-history"
    });

    expect(database.prepare("SELECT COUNT(*) AS count FROM card_import_source_rows WHERE profile_id = 'profile-selected'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM card_import_source_rows WHERE profile_id = 'profile-other'").get()).toEqual({ count: 1 });
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

  it.runIf(process.platform === "win32")("recognizes case-variant raw paths as shared on Windows", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "selected", "sandbox-connection");
    insertAccount(database, "sibling", "sandbox-connection");
    insertHistory(database, "selected");
    insertHistory(database, "sibling");
    await mkdir(config.rawDataDirectory, { recursive: true });
    const rawPath = join(config.rawDataDirectory, "shared.json");
    await writeFile(rawPath, "{}\n");
    insertRawTransaction(database, "selected", rawPath);
    database.prepare("UPDATE transactions_raw SET raw_response_path = ? WHERE account_id = ?").run(rawPath.toUpperCase(), "sibling");

    await expect(removeLocalAccount({ database, environment: "sandbox", accountId: "selected", mode: "delete-history", rawDataDirectory: config.rawDataDirectory })).resolves.toMatchObject({ rawCleanup: { removed: 0, warnings: ["shared"] } });
    await expect(writeFile(rawPath, "{}\n", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
    database.close();
  });

  it("returns a non-sensitive cleanup warning when a raw filesystem operation fails", async () => {
    await expect(
      cleanupRawFiles(["C:/safe/raw.json"], "C:/safe", () => false, {
        lstat: () => Promise.resolve({ isSymbolicLink: () => false, isFile: () => true }),
        unlink: () => Promise.reject(new Error("Disk error token=secret"))
      })
    ).resolves.toEqual({ removed: 0, warnings: ["cleanup-failed"] });
  });

  it("returns a safe warning when raw ownership lookup fails after the database purge", async () => {
    await expect(
      cleanupRawFiles(
        ["C:/safe/raw.json"],
        "C:/safe",
        () => {
          throw new Error("Ownership lookup token=secret");
        },
        {
          lstat: () => Promise.resolve({ isSymbolicLink: () => false, isFile: () => true }),
          unlink: () => Promise.resolve()
        }
      )
    ).resolves.toEqual({ removed: 0, warnings: ["cleanup-failed"] });
  });

  it("rejects a symbolic-link raw root before it evaluates or deletes a child", async () => {
    const hasOtherOwner = vi.fn();
    const unlink = vi.fn();
    const lstat = vi.fn().mockResolvedValue({
      isSymbolicLink: () => true,
      isFile: () => false
    });

    await expect(
      cleanupRawFiles(["C:/safe/raw.json"], "C:/safe", hasOtherOwner, { lstat, unlink })
    ).resolves.toEqual({ removed: 0, warnings: ["symbolic-link"] });
    expect(lstat).toHaveBeenCalledWith(process.platform === "win32" ? "c:\\safe" : resolve("C:/safe"));
    expect(hasOtherOwner).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it("rejects a Windows junction root through the portable symbolic-link seam", async () => {
    const unlink = vi.fn();
    const lstat = vi.fn().mockResolvedValue({
      isSymbolicLink: () => true,
      isFile: () => false
    });

    await expect(
      cleanupRawFiles(["C:/safe/raw.json"], "C:/safe", () => false, { lstat, unlink })
    ).resolves.toEqual({ removed: 0, warnings: ["symbolic-link"] });
    expect(unlink).not.toHaveBeenCalled();
  });

  it("rejects a symbolic link within the RawStore directory hierarchy", async () => {
    const rawRoot = resolve("raw-store-root");
    const dateDirectory = join(rawRoot, "2026-09-13");
    const rawPath = join(dateDirectory, "account", "transactions.json");
    const expectedDateDirectory = process.platform === "win32" ? dateDirectory.toLowerCase() : dateDirectory;
    const expectedRawPath = process.platform === "win32" ? rawPath.toLowerCase() : rawPath;
    const unlink = vi.fn();
    const lstat = vi.fn((path: string) => Promise.resolve({
      isSymbolicLink: () => path === expectedDateDirectory,
      isFile: () => path === expectedRawPath
    }));

    await expect(
      cleanupRawFiles([rawPath], rawRoot, () => false, { lstat, unlink })
    ).resolves.toEqual({ removed: 0, warnings: ["symbolic-link"] });
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not validate the raw root when there are no raw paths", async () => {
    const lstat = vi.fn().mockRejectedValue(Object.assign(new Error("missing root"), { code: "ENOENT" }));

    await expect(
      cleanupRawFiles([], "C:/missing", () => false, { lstat, unlink: vi.fn() })
    ).resolves.toEqual({ removed: 0, warnings: [] });
    expect(lstat).not.toHaveBeenCalled();
  });

  it("restores a purged account when snapshot persistence must be compensated", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-removal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    insertConnection(database, "sandbox-connection", "sandbox");
    insertAccount(database, "account", "sandbox-connection");
    insertHistory(database, "account");

    const pending = await beginLocalAccountRemoval({
      database,
      environment: "sandbox",
      accountId: "account",
      mode: "delete-history"
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = 'account'").get()).toEqual({ count: 0 });
    pending.rollback();
    expect(database.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = 'account'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = 'account'").get()).toEqual({ count: 1 });
    database.close();
  });

  it("rejects a symbolic link through the portable cleanup seam", async () => {
    await expect(
      cleanupRawFiles(["C:/safe/raw.json"], "C:/safe", () => false, {
        lstat: () => Promise.resolve({ isSymbolicLink: () => true, isFile: () => false }),
        unlink: () => Promise.resolve()
      })
    ).resolves.toEqual({ removed: 0, warnings: ["symbolic-link"] });
  });
});
