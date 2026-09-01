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

function providerIdentificationHash(
  paths: string[][],
  digest: string
): string {
  return `${Buffer.from(JSON.stringify(paths)).toString("base64")}.${digest}`;
}

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
    const iban = "ES0100000000000000000001";
    const primaryHash = providerIdentificationHash(
      [["account", "account_id", "iban"], ["account", "currency"]],
      "primary"
    );
    const secondaryHash = providerIdentificationHash(
      [["account", "account_id", "iban"]],
      "secondary"
    );
    const canonicalId = repository.upsert(
      "connection",
      {
        uid: "old-provider-id",
        identification_hash: primaryHash,
        account_id: { iban },
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
           iban_masked, active, first_seen_at, last_seen_at
         ) VALUES ('duplicate', 'connection', 'new-provider-id', 'old-duplicate-hash', 'Duplicate',
                   'ES************01', 1, ?, ?)`
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
          identification_hashes: [primaryHash, secondaryHash],
          account_id: { iban },
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
        identification_hash: primaryHash,
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
      { identification_hash: primaryHash, account_id: canonicalId },
      { identification_hash: secondaryHash, account_id: canonicalId }
    ]);
    database.close();
  });

  it("reuses an account when a later response contains only a verified secondary IBAN hash", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-secondary-hash-"));
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
    const iban = "ES0100000000000000000001";
    const primaryHash = providerIdentificationHash(
      [["account", "account_id", "iban"], ["account", "currency"]],
      "primary"
    );
    const secondaryHash = providerIdentificationHash(
      [["account", "account_id", "iban"]],
      "secondary"
    );
    const originalId = repository.upsert(
      "connection",
      {
        uid: "old-provider-id",
        identification_hash: primaryHash,
        identification_hashes: [primaryHash, secondaryHash],
        account_id: { iban },
        details: "Household account",
        currency: "EUR"
      },
      null
    );
    database
      .prepare("UPDATE accounts SET account_alias = 'Household' WHERE id = ?")
      .run(originalId);

    expect(
      repository.upsert(
        "connection",
        {
          uid: "new-provider-id",
          identification_hash: secondaryHash,
          identification_hashes: [secondaryHash],
          account_id: { iban },
          details: "Household account",
          currency: "EUR"
        },
        null
      )
    ).toBe(originalId);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count, provider_account_id, account_alias
           FROM accounts`
        )
        .get()
    ).toEqual({
      count: 1,
      provider_account_id: "new-provider-id",
      account_alias: "Household"
    });
    database.close();
  });

  it("retains verified IBAN hashes omitted from intermediate provider responses", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-retained-hashes-"));
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
    const iban = "ES0100000000000000000001";
    const hashes = ["primary", "secondary-b", "secondary-c"].map((digest) =>
      providerIdentificationHash([["account", "account_id", "iban"]], digest)
    );
    const [, secondaryBHash, secondaryCHash] = hashes;
    if (!secondaryBHash || !secondaryCHash) {
      throw new Error("Expected three account hash fixtures.");
    }
    const originalId = repository.upsert(
      "connection",
      {
        uid: "original-provider-id",
        identification_hashes: hashes,
        account_id: { iban },
        details: "Household account",
        currency: "EUR"
      },
      null
    );
    database
      .prepare("UPDATE accounts SET account_alias = 'Household' WHERE id = ?")
      .run(originalId);

    expect(
      repository.upsert(
        "connection",
        {
          uid: "original-provider-id",
          identification_hashes: [secondaryBHash],
          account_id: { iban },
          details: "Household account",
          currency: "EUR"
        },
        null
      )
    ).toBe(originalId);
    expect(
      repository.upsert(
        "connection",
        {
          uid: "changed-provider-id",
          identification_hashes: [secondaryCHash],
          account_id: { iban },
          details: "Household account",
          currency: "EUR"
        },
        null
      )
    ).toBe(originalId);
    expect(
      database
        .prepare(
          `SELECT identification_hash
           FROM account_identification_hashes
           WHERE account_id = ? AND verified = 1
           ORDER BY identification_hash`
        )
        .all(originalId)
    ).toEqual(
      [...hashes]
        .sort()
        .map((identificationHash) => ({ identification_hash: identificationHash }))
    );
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count, provider_account_id, account_alias
           FROM accounts`
        )
        .get()
    ).toEqual({
      count: 1,
      provider_account_id: "changed-provider-id",
      account_alias: "Household"
    });
    database.close();
  });

  it("keeps distinct IBAN accounts when the provider gives them the same name hash", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-name-collision-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Kutxabank', 'ES',
                   'personal', 'Kutxabank personal', 'AUTHORIZED', ?)`
      )
      .run(new Date().toISOString());
    const repository = new AccountRepository(database);
    const sharedNameHash = providerIdentificationHash(
      [["aspsp_name"], ["aspsp_country"], ["account", "name"]],
      "shared-name"
    );
    const accounts = [
      { uid: "provider-payroll", iban: "ES0100000000000000000001", details: "Payroll" },
      { uid: "provider-savings", iban: "ES0100000000000000000002", details: "Savings" },
      { uid: "provider-shared", iban: "ES0100000000000000000003", details: "Shared" }
    ];

    for (const [index, account] of accounts.entries()) {
      const ibanHash = providerIdentificationHash(
        [["account", "account_id", "iban"], ["account", "currency"]],
        `iban-${index}`
      );
      repository.upsert(
        "connection",
        {
          uid: account.uid,
          identification_hash: ibanHash,
          identification_hashes: [ibanHash, sharedNameHash],
          account_id: { iban: account.iban },
          name: "CUENTA",
          details: account.details,
          currency: "EUR"
        },
        null
      );
    }

    const storedAccounts = database
      .prepare(
        `SELECT provider_account_id, display_name
         FROM accounts ORDER BY provider_account_id`
      )
      .all();
    database.close();
    expect(storedAccounts).toEqual([
      { provider_account_id: "provider-payroll", display_name: "Payroll" },
      { provider_account_id: "provider-savings", display_name: "Savings" },
      { provider_account_id: "provider-shared", display_name: "Shared" }
    ]);
  });

  it("does not merge through a contaminated historical hash alias", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-alias-collision-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Kutxabank', 'ES',
                   'personal', 'Kutxabank personal', 'AUTHORIZED', ?)`
      )
      .run(new Date().toISOString());
    const repository = new AccountRepository(database);
    const firstHash = providerIdentificationHash(
      [["account", "account_id", "iban"]],
      "first-iban"
    );
    const secondHash = providerIdentificationHash(
      [["account", "account_id", "iban"]],
      "second-iban"
    );
    const firstId = repository.upsert(
      "connection",
      {
        uid: "provider-first",
        identification_hash: firstHash,
        account_id: { iban: "ES0100000000000000000001" },
        details: "First account",
        currency: "EUR"
      },
      null
    );
    database
      .prepare(
        `INSERT INTO account_identification_hashes (
           bank_connection_id, identification_hash, account_id
         ) VALUES ('connection', ?, ?)`
      )
      .run(secondHash, firstId);

    const secondId = repository.upsert(
      "connection",
      {
        uid: "provider-second",
        identification_hash: secondHash,
        account_id: { iban: "ES0199999999999999999901" },
        details: "Second account",
        currency: "EUR"
      },
      null
    );
    const stored = database
      .prepare(
        `SELECT provider_account_id, display_name
         FROM accounts ORDER BY provider_account_id`
      )
      .all();
    database.close();

    expect(secondId).not.toBe(firstId);
    expect(stored).toEqual([
      { provider_account_id: "provider-first", display_name: "First account" },
      { provider_account_id: "provider-second", display_name: "Second account" }
    ]);
  });
});
