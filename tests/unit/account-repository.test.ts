import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/storage/database.js";
import { AccountRepository } from "../../src/storage/repositories/account-repository.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("account synchronization eligibility", () => {
  it("excludes accounts from revoked or reauthorization-required connections", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-repository-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at, reauthorization_required
       ) VALUES (?, 'enable-banking', 'sandbox', ?, 'ES', 'personal', ?, ?, ?, ?)`
    );
    insertConnection.run(
      "authorized",
      "Authorized Bank",
      "Authorized Bank personal",
      "AUTHORIZED",
      now,
      0
    );
    insertConnection.run(
      "revoked",
      "Revoked Bank",
      "Revoked Bank personal",
      "REVOKED",
      now,
      1
    );
    insertConnection.run(
      "reauthorization",
      "Expired Bank",
      "Expired Bank personal",
      "AUTHORIZED",
      now,
      1
    );
    const insertAccount = database.prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name,
         active, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?)`
    );
    insertAccount.run(
      "account-authorized",
      "authorized",
      "provider-authorized",
      "Authorized account",
      now,
      now
    );
    insertAccount.run(
      "account-revoked",
      "revoked",
      "provider-revoked",
      "Revoked account",
      now,
      now
    );
    insertAccount.run(
      "account-expired",
      "reauthorization",
      "provider-expired",
      "Expired account",
      now,
      now
    );

    expect(new AccountRepository(database).listActive().map((row) => row.id)).toEqual([
      "account-authorized"
    ]);
    database.close();
  });
});
