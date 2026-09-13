import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/storage/database.js";
import { resetLocalData } from "../../src/storage/local-data-reset.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("resetLocalData", () => {
  it("removes local financial history while preserving access and configuration", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reset-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(`INSERT INTO bank_connections (
        id, provider, environment, bank_name, bank_country, psu_type, alias,
        status, created_at, last_sync_at
      ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
        'personal', 'Demo', 'AUTHORIZED', ?, ?)`)
      .run(now, now);
    database
      .prepare(`INSERT INTO provider_sessions (
        id, bank_connection_id, provider_session_id_ciphertext, created_at, status
      ) VALUES ('session', 'connection', 'encrypted', ?, 'AUTHORIZED')`)
      .run(now);
    database
      .prepare(`INSERT INTO accounts (
        id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
      ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`)
      .run(now, now);
    database
      .prepare(
        `UPDATE accounts SET
           last_error_at = ?, last_error_code = 'RESOURCE_EXPIRED',
           last_error_message_safe = 'Previous synchronization error'
         WHERE id = 'account'`
      )
      .run(now);
    database
      .prepare(`INSERT INTO transactions (
        id, movement_key, reconciliation_key, provider, environment, bank_connection_id,
        account_id, status, amount, currency, direction, description_normalized,
        first_seen_at, last_seen_at, imported_at, raw_fingerprint
      ) VALUES ('transaction', 'movement', 'reconciliation', 'enable-banking', 'sandbox',
        'connection', 'account', 'booked', '1.00', 'EUR', 'income', 'TEST', ?, ?, ?, 'fingerprint')`)
      .run(now, now, now);
    database
      .prepare(`INSERT INTO card_import_source_rows (
        profile_id, source_path_hash, semantic_key_hash, occurrence,
        provider_transaction_id, first_seen_at, last_seen_at
      ) VALUES ('profile', 'path-hash', 'semantic-hash', 1, 'provider-id', ?, ?)`)
      .run(now, now);
    database
      .prepare(`INSERT INTO balances (id, account_id, amount, currency, extracted_at)
        VALUES ('balance', 'account', '1.00', 'EUR', ?)`)
      .run(now);
    database
      .prepare(`INSERT INTO transactions_raw (id, account_id, fetched_at, page_number, raw_fingerprint)
        VALUES ('raw', 'account', ?, 1, 'fingerprint')`)
      .run(now);
    database
      .prepare("INSERT INTO sync_runs (id, started_at, status) VALUES ('sync-run', ?, 'SUCCESS')")
      .run(now);
    database
      .prepare(`INSERT INTO desktop_runs (
        id, started_at, status, date_from, date_to, steps_json
      ) VALUES ('desktop-run', ?, 'SUCCESS', '2026-01-01', '2026-01-01', '[]')`)
      .run(now);
    database
      .prepare(`INSERT INTO local_account_removal_audit_events (id, action, outcome, occurred_at)
        VALUES ('removal-audit', 'local-account-removal', 'deleted', ?)`)
      .run(now);
    await mkdir(join(config.rawDataDirectory, "transactions"), { recursive: true });
    await writeFile(join(config.rawDataDirectory, ".gitkeep"), "");
    await writeFile(join(config.rawDataDirectory, "transactions", "sample.json"), "{}");
    await mkdir(config.exportDirectory, { recursive: true });
    await writeFile(join(config.exportDirectory, "kakebo_movements.csv"), "MovementKey\nmovement\n");

    await expect(resetLocalData(config, database)).resolves.toEqual({
      exportFiles: 1,
      transactions: 1,
      balances: 1,
      synchronizationRuns: 1,
      desktopRuns: 1,
      cleanupWarnings: []
    });
    for (const table of ["bank_connections", "provider_sessions", "accounts"]) {
      expect(database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).toEqual({ total: 1 });
    }
    expect(database.prepare("SELECT last_sync_at FROM bank_connections").get()).toEqual({ last_sync_at: null });
    expect(
      database
        .prepare(
          `SELECT last_error_at, last_error_code, last_error_message_safe
           FROM accounts WHERE id = 'account'`
        )
        .get()
    ).toEqual({
      last_error_at: null,
      last_error_code: null,
      last_error_message_safe: null
    });
    for (const table of [
      "transactions",
      "card_import_source_rows",
      "transactions_raw",
      "balances",
      "sync_runs",
      "desktop_runs",
      "local_account_removal_audit_events"
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).toEqual({ total: 0 });
    }
    await expect(access(join(config.rawDataDirectory, ".gitkeep"))).resolves.toBeUndefined();
    await expect(
      access(join(config.rawDataDirectory, "transactions"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    database.close();
  });

  it("reports locked cleanup files without hiding the committed database reset", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reset-partial-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(`INSERT INTO bank_connections (
        id, provider, environment, bank_name, bank_country, psu_type, alias,
        status, created_at, last_sync_at
      ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
        'personal', 'Demo', 'AUTHORIZED', ?, ?)`)
      .run(now, now);
    database
      .prepare(`INSERT INTO accounts (
        id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
      ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`)
      .run(now, now);
    database
      .prepare(`INSERT INTO transactions (
        id, movement_key, reconciliation_key, provider, environment, bank_connection_id,
        account_id, status, amount, currency, direction, description_normalized,
        first_seen_at, last_seen_at, imported_at, raw_fingerprint
      ) VALUES ('transaction', 'movement', 'reconciliation', 'enable-banking', 'sandbox',
        'connection', 'account', 'booked', '1', 'EUR', 'income', 'TEST', ?, ?, ?, 'fingerprint')`)
      .run(now, now, now);

    const result = await resetLocalData(config, database, {
      clearExports: () => Promise.reject(new Error("locked export")),
      clearRawData: () => Promise.reject(new Error("locked raw file"))
    });

    expect(result).toEqual({
      exportFiles: 0,
      transactions: 1,
      balances: 0,
      synchronizationRuns: 0,
      desktopRuns: 0,
      cleanupWarnings: ["exports", "raw-data"]
    });
    expect(database.prepare("SELECT COUNT(*) AS total FROM transactions").get()).toEqual({
      total: 0
    });
    expect(database.prepare("SELECT last_sync_at FROM bank_connections").get()).toEqual({
      last_sync_at: null
    });
    database.close();
  });

  it("refuses to delete raw data through a directory link", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reset-linked-raw-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const linkedTarget = join(root, "linked-raw-target");
    await mkdir(linkedTarget, { recursive: true });
    await writeFile(join(linkedTarget, "must-remain.json"), "{}");
    await symlink(linkedTarget, config.rawDataDirectory, "junction");

    const result = await resetLocalData(config, database);

    expect(result.cleanupWarnings).toContain("raw-data");
    await expect(
      access(join(linkedTarget, "must-remain.json"))
    ).resolves.toBeUndefined();
    database.close();
  });

  it("rolls back every database deletion and skips file cleanup when SQLite fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reset-rollback-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(`INSERT INTO bank_connections (
        id, provider, environment, bank_name, bank_country, psu_type, alias,
        status, created_at, last_sync_at
      ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
        'personal', 'Demo', 'AUTHORIZED', ?, ?)`)
      .run(now, now);
    database
      .prepare(`INSERT INTO accounts (
        id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
      ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`)
      .run(now, now);
    database
      .prepare(`INSERT INTO transactions (
        id, movement_key, reconciliation_key, provider, environment, bank_connection_id,
        account_id, status, amount, currency, direction, description_normalized,
        first_seen_at, last_seen_at, imported_at, raw_fingerprint
      ) VALUES ('transaction', 'movement', 'reconciliation', 'enable-banking', 'sandbox',
        'connection', 'account', 'booked', '1', 'EUR', 'income', 'TEST', ?, ?, ?, 'fingerprint')`)
      .run(now, now, now);
    database
      .prepare(`INSERT INTO desktop_runs (
        id, started_at, status, date_from, date_to, steps_json
      ) VALUES ('desktop-run', ?, 'SUCCESS', '2026-01-01', '2026-01-01', '[]')`)
      .run(now);
    database
      .prepare(`INSERT INTO card_import_source_rows (
        profile_id, source_path_hash, semantic_key_hash, occurrence,
        provider_transaction_id, first_seen_at, last_seen_at
      ) VALUES ('profile', 'path-hash', 'semantic-hash', 1, 'provider-id', ?, ?)`)
      .run(now, now);
    database.exec(`CREATE TRIGGER prevent_desktop_run_delete
      BEFORE DELETE ON desktop_runs
      BEGIN
        SELECT RAISE(ABORT, 'simulated reset failure');
      END`);
    const clearExports = vi.fn(() => Promise.resolve(0));
    const clearRawData = vi.fn(() => Promise.resolve());

    await expect(
      resetLocalData(config, database, { clearExports, clearRawData })
    ).rejects.toThrow("simulated reset failure");

    expect(clearExports).not.toHaveBeenCalled();
    expect(clearRawData).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS total FROM transactions").get()).toEqual({
      total: 1
    });
    expect(database.prepare("SELECT COUNT(*) AS total FROM desktop_runs").get()).toEqual({
      total: 1
    });
    expect(
      database.prepare("SELECT COUNT(*) AS total FROM card_import_source_rows").get()
    ).toEqual({ total: 1 });
    expect(database.prepare("SELECT last_sync_at FROM bank_connections").get()).toEqual({
      last_sync_at: now
    });
    database.close();
  });
});
