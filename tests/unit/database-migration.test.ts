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
           id, bank_connection_id, provider_account_id, account_alias,
           first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider-account', 'Household', ?, ?)`
      )
      .run(now, now);
    legacy.close();

    const migrated = createDatabase(config.databasePath);
    expect(migrated.pragma("user_version", { simple: true })).toBe(3);
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
    migrated.close();
  });
});
