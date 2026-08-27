import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { transactionsResponseSchema } from "../../src/enable-banking/schemas.js";
import { TransactionsPeriodError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("paginated transaction synchronization", () => {
  it("reads all pages and remains idempotent on the next run", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-pagination-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Banco Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES (
           'session', 'connection', 'encrypted-session', ?, 'AUTHORIZED'
         )`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           name, active, first_seen_at, last_seen_at
         ) VALUES (
           'account', 'connection', 'provider-account', 'stable-account',
           'Cuenta Demo', 1, ?, ?
         )`
      )
      .run(now, now);

    const firstFixture = transactionsResponseSchema.parse(
      JSON.parse(
        await readFile(
          resolve("tests/fixtures/transactions-page-1.json"),
          "utf8"
        )
      )
    );
    const secondFixture = transactionsResponseSchema.parse(
      JSON.parse(
        await readFile(
          resolve("tests/fixtures/transactions-page-2.json"),
          "utf8"
        )
      )
    );
    const getTransactions = vi.fn(
      (
        _accountId: string,
        query: { continuationKey?: string }
      ) => Promise.resolve(query.continuationKey ? secondFixture : firstFixture)
    );
    const fakeClient = { getTransactions } as unknown as EnableBankingClient;
    const service = new SyncService(config, database, fakeClient);

    const first = await service.syncTransactions("2026-07-01", "2026-07-24");
    const second = await service.syncTransactions("2026-07-01", "2026-07-24");

    expect(first).toMatchObject({ pages: 2, received: 2, inserted: 2 });
    expect(second).toMatchObject({ pages: 2, received: 2, duplicates: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM transactions").get()
    ).toEqual({ count: 2 });
    expect(getTransactions).toHaveBeenCalledTimes(4);
    expect(getTransactions.mock.calls[1]?.[1]).toMatchObject({
      continuationKey: "page-2"
    });
    database.close();
  });

  it("retries an unavailable period with the longest strategy and keeps the selected range", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-longest-period-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Banco Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES (
           'session', 'connection', 'encrypted-session', ?, 'AUTHORIZED'
         )`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           name, active, first_seen_at, last_seen_at
         ) VALUES (
           'account', 'connection', 'provider-account', 'stable-account',
           'Cuenta Demo', 1, ?, ?
         )`
      )
      .run(now, now);
    const longestResponse = transactionsResponseSchema.parse({
      transactions: [
        {
          entry_reference: "before-range",
          transaction_amount: { currency: "EUR", amount: "10.00" },
          credit_debit_indicator: "DBIT",
          status: "BOOK",
          booking_date: "2025-12-31",
          remittance_information: "Before range"
        },
        {
          entry_reference: "inside-range",
          transaction_amount: { currency: "EUR", amount: "20.00" },
          credit_debit_indicator: "DBIT",
          status: "BOOK",
          booking_date: "2026-04-15",
          remittance_information: "Inside range"
        },
        {
          entry_reference: "after-range",
          transaction_amount: { currency: "EUR", amount: "30.00" },
          credit_debit_indicator: "DBIT",
          status: "BOOK",
          booking_date: "2026-07-28",
          remittance_information: "After range"
        }
      ],
      continuation_key: null
    });
    const getTransactions = vi
      .fn()
      .mockRejectedValueOnce(new TransactionsPeriodError())
      .mockResolvedValueOnce(longestResponse);
    const fakeClient = { getTransactions } as unknown as EnableBankingClient;
    const service = new SyncService(config, database, fakeClient);

    const result = await service.syncTransactions("2026-01-01", "2026-07-27");

    expect(result).toMatchObject({ pages: 1, received: 1, inserted: 1 });
    expect(getTransactions).toHaveBeenCalledTimes(2);
    expect(getTransactions.mock.calls[0]?.[1]).toEqual({
      dateFrom: "2026-01-01",
      dateTo: "2026-07-27"
    });
    expect(getTransactions.mock.calls[1]?.[1]).toEqual({
      dateFrom: "2026-01-01",
      strategy: "longest"
    });
    expect(
      database
        .prepare(
          `SELECT entry_reference, booking_date, fallback_occurrence
           FROM transactions`
        )
        .all()
    ).toEqual([
      {
        entry_reference: "inside-range",
        booking_date: "2026-04-15",
        fallback_occurrence: 1
      }
    ]);
    database.close();
  });

  it("preserves repeated ID-less movements and remains idempotent", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-repeated-idless-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Banco Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', 'encrypted-session', ?, 'AUTHORIZED')`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           name, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider-account', 'stable-account',
                   'Cuenta Demo', 1, ?, ?)`
      )
      .run(now, now);
    const repeatedMovement = {
      transaction_amount: { currency: "EUR", amount: "2.50" },
      credit_debit_indicator: "DBIT" as const,
      status: "BOOK",
      booking_date: "2026-07-24",
      remittance_information: "Identical transit fare"
    };
    const firstPage = transactionsResponseSchema.parse({
      transactions: [repeatedMovement],
      continuation_key: "repeated-page-2"
    });
    const secondPage = transactionsResponseSchema.parse({
      transactions: [repeatedMovement],
      continuation_key: null
    });
    const client = {
      getTransactions: vi.fn(
        (_accountId: string, query: { continuationKey?: string }) =>
          Promise.resolve(query.continuationKey ? secondPage : firstPage)
      )
    } as unknown as EnableBankingClient;
    const service = new SyncService(config, database, client);

    const first = await service.syncTransactions("2026-07-01", "2026-07-31");
    const second = await service.syncTransactions("2026-07-01", "2026-07-31");

    expect(first).toMatchObject({ received: 2, inserted: 2 });
    expect(second).toMatchObject({ received: 2, duplicates: 2 });
    expect(
      database
        .prepare(
          `SELECT fallback_occurrence
           FROM transactions ORDER BY fallback_occurrence`
        )
        .all()
    ).toEqual([{ fallback_occurrence: 1 }, { fallback_occurrence: 2 }]);
    database.close();
  });

  it("reconciles repeated ID-less movements when one later gains a provider ID", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-enriched-idless-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Banco Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', 'encrypted-session', ?, 'AUTHORIZED')`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           name, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider-account', 'stable-account',
                   'Cuenta Demo', 1, ?, ?)`
      )
      .run(now, now);
    const idlessMovement = {
      transaction_amount: { currency: "EUR", amount: "2.50" },
      credit_debit_indicator: "DBIT" as const,
      status: "BOOK",
      booking_date: "2026-07-24",
      remittance_information: "Identical transit fare"
    };
    const identifiedMovement = {
      ...idlessMovement,
      transaction_id: "provider-enriched-id"
    };
    const responses = [
      transactionsResponseSchema.parse({
        transactions: [idlessMovement, idlessMovement],
        continuation_key: null
      }),
      transactionsResponseSchema.parse({
        transactions: [idlessMovement, identifiedMovement],
        continuation_key: null
      }),
      transactionsResponseSchema.parse({
        transactions: [identifiedMovement, idlessMovement],
        continuation_key: null
      })
    ];
    const client = {
      getTransactions: vi
        .fn()
        .mockResolvedValueOnce(responses[0])
        .mockResolvedValueOnce(responses[1])
        .mockResolvedValueOnce(responses[2])
    } as unknown as EnableBankingClient;
    const service = new SyncService(config, database, client);

    const first = await service.syncTransactions("2026-07-01", "2026-07-31");
    const initialMovementKeys = database
      .prepare("SELECT movement_key FROM transactions ORDER BY fallback_occurrence")
      .all();
    const enriched = await service.syncTransactions("2026-07-01", "2026-07-31");
    const reordered = await service.syncTransactions("2026-07-01", "2026-07-31");

    expect(first).toMatchObject({ received: 2, inserted: 2 });
    expect(enriched).toMatchObject({ received: 2, updated: 1, duplicates: 1 });
    expect(reordered).toMatchObject({ received: 2, duplicates: 2 });
    expect(
      database
        .prepare("SELECT movement_key FROM transactions ORDER BY fallback_occurrence")
        .all()
    ).toEqual(initialMovementKeys);
    expect(
      database
        .prepare(
          `SELECT provider_transaction_id, fallback_occurrence
           FROM transactions
           ORDER BY fallback_occurrence`
        )
        .all()
    ).toEqual([
      { provider_transaction_id: null, fallback_occurrence: 1 },
      { provider_transaction_id: "provider-enriched-id", fallback_occurrence: 2 }
    ]);
    database.close();
  });
});
