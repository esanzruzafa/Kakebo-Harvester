import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/storage/database.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("database migrations", () => {
  it("upgrades a version-one database without losing existing account data", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-database-migration-"));
    const config = testConfig(root);
    const legacy = new Database(config.databasePath);
    legacy.exec(
      readFileSync(
        resolve("src", "storage", "migrations", "001_initial.sql"),
        "utf8"
      )
    );
    legacy.pragma("user_version = 1");
    const now = new Date().toISOString();
    legacy
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES (
           'connection', 'enable-banking', 'production', 'Demo Bank', 'ES',
           'personal', 'Demo Bank personal', 'AUTHORIZED', ?
         )`
      )
      .run(now);
    legacy
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           account_alias,
           first_seen_at, last_seen_at
         ) VALUES (
           'account', 'connection', 'provider-account', 'stable-hash',
           'Household', ?, ?
         )`
      )
      .run(now, now);
    legacy.close();

    const migrated = createDatabase(config.databasePath);
    expect(migrated.pragma("user_version", { simple: true })).toBe(8);
    expect(
      migrated
        .prepare(
          `SELECT account_alias, sync_enabled, export_enabled
           FROM accounts WHERE id = 'account'`
        )
        .get()
    ).toEqual({
      account_alias: "Household",
      sync_enabled: 1,
      export_enabled: 1
    });
    const columns = migrated.pragma("table_info(bank_connections)") as Array<{
      name: string;
    }>;
    expect(columns.some((column) => column.name === "retry_after_at")).toBe(true);
    expect(
      columns.some(
        (column) => column.name === "required_psu_headers_json"
      )
    ).toBe(true);
    expect(columns.some((column) => column.name === "online_retry_used")).toBe(
      true
    );
    const accountColumns = migrated.pragma("table_info(accounts)") as Array<{
      name: string;
    }>;
    expect(accountColumns.some((column) => column.name === "last_error_at")).toBe(
      true
    );
    expect(
      migrated
        .prepare(
          `SELECT bank_connection_id, identification_hash, account_id
           FROM account_identification_hashes`
        )
        .get()
    ).toEqual({
      bank_connection_id: "connection",
      identification_hash: "stable-hash",
      account_id: "account"
    });
    migrated.close();
  });

  it("backfills a recent legacy rate limit without another provider call", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-rate-limit-migration-"));
    const config = testConfig(root);
    const legacy = new Database(config.databasePath);
    for (const filename of [
      "001_initial.sql",
      "002_desktop.sql",
      "003_audit_and_exports.sql"
    ]) {
      legacy.exec(
        readFileSync(
          resolve("src", "storage", "migrations", filename),
          "utf8"
        )
      );
    }
    legacy.pragma("user_version = 3");
    legacy
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES (
           'connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
           'personal', 'Demo personal', 'AUTHORIZED',
           '2026-07-28T10:00:00.000Z'
         )`
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO desktop_runs (
           id, started_at, finished_at, status, date_from, date_to,
           steps_json, error_message_safe
         ) VALUES (
           'run', '2026-07-28T10:30:00.000Z', '2026-07-28T10:31:00.000Z',
           'FAILED', '2026-01-01', '2026-07-28', '["accounts"]',
           'Enable Banking ha limitado temporalmente las solicitudes.'
         )`
      )
      .run();
    legacy.close();

    const migrated = createDatabase(config.databasePath);
    expect(
      migrated
        .prepare(
          `SELECT retry_after_at, error_code
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({
      retry_after_at: "2026-07-28T16:30:00.000Z",
      error_code: "RATE_LIMIT_EXCEEDED"
    });
    migrated.close();
  });

  it(
    "does not assign an ambiguous legacy rate limit to every connection",
    async () => {
      root = await mkdtemp(join(tmpdir(), "kakebo-rate-limit-multi-migration-"));
      const config = testConfig(root);
      const legacy = new Database(config.databasePath);
      for (const filename of [
        "001_initial.sql",
        "002_desktop.sql",
        "003_audit_and_exports.sql"
      ]) {
        legacy.exec(
          readFileSync(
            resolve("src", "storage", "migrations", filename),
            "utf8"
          )
        );
      }
      legacy.pragma("user_version = 3");
      for (const id of ["connection-a", "connection-b"]) {
        legacy
          .prepare(
            `INSERT INTO bank_connections (
               id, provider, environment, bank_name, bank_country, psu_type,
               alias, status, created_at
             ) VALUES (?, 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
               'personal', ?, 'AUTHORIZED', '2026-07-28T10:00:00.000Z')`
          )
          .run(id, id);
      }
      legacy
        .prepare(
          `INSERT INTO desktop_runs (
             id, started_at, finished_at, status, date_from, date_to,
             steps_json, error_message_safe
           ) VALUES (
             'run', '2026-07-28T10:30:00.000Z', '2026-07-28T10:31:00.000Z',
             'FAILED', '2026-01-01', '2026-07-28', '["accounts"]',
             'Enable Banking ha limitado temporalmente las solicitudes.'
           )`
        )
        .run();
      legacy.close();

      const migrated = createDatabase(config.databasePath);
      expect(migrated.pragma("user_version", { simple: true })).toBe(8);
      expect(
        migrated
          .prepare(
            `SELECT retry_after_at, error_code
             FROM bank_connections ORDER BY id`
          )
          .all()
      ).toEqual([
        { retry_after_at: null, error_code: null },
        { retry_after_at: null, error_code: null }
      ]);
      migrated.close();
    },
    15_000
  );
});
