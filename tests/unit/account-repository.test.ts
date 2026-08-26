import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/storage/database.js";
import { AccountRepository } from "../../src/storage/repositories/account-repository.js";
import { TransactionRepository } from "../../src/transactions/deduplication.js";
import { mapTransaction } from "../../src/transactions/transaction-mapper.js";
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

  it("reconciles plural identification hashes without losing account settings", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-hashes-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
                   'personal', 'Demo Bank personal', 'AUTHORIZED', ?)`
      )
      .run(now);
    const repository = new AccountRepository(database);
    const canonicalId = repository.upsert(
      "connection",
      {
        uid: "old-provider-id",
        identification_hash: "stable-hash",
        name: "Current account",
        currency: "EUR"
      },
      null
    );
    database
      .prepare(
        `UPDATE accounts
         SET account_alias = 'Household'
         WHERE id = ?`
      )
      .run(canonicalId);
    const transactionRepository = new TransactionRepository(database);
    const providerTransaction = {
      status: "BOOK",
      booking_date: "2026-08-20",
      transaction_amount: { amount: "-25.00", currency: "EUR" },
      remittance_information: "Recurring purchase"
    };
    const originalCanonicalAccount = repository.findByProviderAccountId(
      "connection",
      "old-provider-id"
    );
    expect(originalCanonicalAccount).toBeDefined();
    if (!originalCanonicalAccount) {
      throw new Error("Expected original canonical account fixture.");
    }
    expect(
      transactionRepository.upsert(
        mapTransaction({
          transaction: providerTransaction,
          account: originalCanonicalAccount,
          environment: "sandbox",
          rawPath: null
        })
      )
    ).toBe("inserted");
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash, name,
           active, first_seen_at, last_seen_at
         ) VALUES ('duplicate', 'connection', 'new-provider-id', 'old-duplicate-hash', 'Duplicate',
                   1, ?, ?)`
      )
      .run(now, now);
    database
      .prepare(
        `UPDATE accounts SET sync_enabled = 0, export_enabled = 0
         WHERE id = 'duplicate'`
      )
      .run();
    database
      .prepare(
        `INSERT INTO balances (
           id, account_id, amount, currency, extracted_at
         ) VALUES ('balance', 'duplicate', '100', 'EUR', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO desktop_runs (
           id, started_at, finished_at, status, date_from, date_to, steps_json
         ) VALUES ('run', ?, ?, 'SUCCESS', '2026-08-01', '2026-08-20', '[]')`
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO desktop_run_accounts (
           run_id, account_id, bank_name, account_name, amount, currency,
           balance_type, balance_reference_date, balance_extracted_at
         ) VALUES
           ('run', ?, 'Demo Bank', 'Household', NULL, NULL, NULL, NULL, NULL),
           ('run', 'duplicate', 'Demo Bank', 'Duplicate', '100', 'EUR',
            'CLBD', '2026-08-20', ?)`
      )
      .run(canonicalId, now);
    const duplicateAccount = repository.findByProviderAccountId(
      "connection",
      "new-provider-id"
    );
    expect(duplicateAccount).toBeDefined();
    if (!duplicateAccount) throw new Error("Expected duplicate account fixture.");
    expect(
      transactionRepository.upsert(
        mapTransaction({
          transaction: providerTransaction,
          account: duplicateAccount,
          environment: "sandbox",
          rawPath: null
        })
      )
    ).toBe("inserted");
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({
      count: 2
    });

    expect(
      repository.upsert(
        "connection",
        {
          uid: "new-provider-id",
          identification_hashes: ["stable-hash", "secondary-hash"],
          name: "Current account",
          currency: "EUR"
        },
        null
      )
    ).toBe(canonicalId);

    expect(
      database
        .prepare(
          `SELECT id, provider_account_id, identification_hash, account_alias,
                  sync_enabled, export_enabled
           FROM accounts`
        )
        .all()
    ).toEqual([
      {
        id: canonicalId,
        provider_account_id: "new-provider-id",
        identification_hash: "stable-hash",
        account_alias: "Household",
        sync_enabled: 0,
        export_enabled: 0
      }
    ]);
    expect(
      database.prepare("SELECT account_id FROM balances WHERE id = 'balance'").get()
    ).toEqual({ account_id: canonicalId });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({
      count: 1
    });
    expect(
      database
        .prepare(
          `SELECT account_id, account_name, amount, currency, balance_type,
                  balance_reference_date, balance_extracted_at
           FROM desktop_run_accounts`
        )
        .get()
    ).toEqual({
      account_id: canonicalId,
      account_name: "Household",
      amount: "100",
      currency: "EUR",
      balance_type: "CLBD",
      balance_reference_date: "2026-08-20",
      balance_extracted_at: now
    });
    const canonicalAccount = repository.findByProviderAccountId(
      "connection",
      "new-provider-id"
    );
    expect(canonicalAccount).toBeDefined();
    if (!canonicalAccount) throw new Error("Expected canonical account fixture.");
    expect(
      transactionRepository.upsert(
        mapTransaction({
          transaction: providerTransaction,
          account: canonicalAccount,
          environment: "sandbox",
          rawPath: null
        })
      )
    ).toBe("duplicate");
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({
      count: 1
    });
    expect(
      database.prepare("SELECT account_id FROM transactions").get()
    ).toEqual({ account_id: canonicalId });
    expect(
      database
        .prepare(
          `SELECT identification_hash, account_id
           FROM account_identification_hashes
           ORDER BY identification_hash`
        )
        .all()
    ).toEqual([
      { identification_hash: "secondary-hash", account_id: canonicalId },
      { identification_hash: "stable-hash", account_id: canonicalId }
    ]);
    expect(
      repository.upsert(
        "connection",
        {
          uid: "latest-provider-id",
          identification_hash: "secondary-hash",
          name: "Current account",
          currency: "EUR"
        },
        null
      )
    ).toBe(canonicalId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({
      count: 1
    });
    database.close();
  });
});
