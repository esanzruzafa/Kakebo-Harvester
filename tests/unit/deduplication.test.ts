import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/storage/database.js";
import { TransactionRepository } from "../../src/transactions/deduplication.js";
import type { NormalizedTransaction } from "../../src/transactions/transaction-mapper.js";
import { createId } from "../../src/utils/crypto.js";

function transaction(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    movement_key: "pending-key",
    reconciliation_key: "same-purchase",
    provider: "enable-banking",
    environment: "sandbox",
    bank_connection_id: "connection",
    account_id: "account",
    provider_transaction_id: null,
    entry_reference: null,
    fallback_occurrence: null,
    status: "pending",
    booking_date: "2026-07-24",
    value_date: null,
    transaction_datetime: null,
    amount: "-12.34",
    currency: "EUR",
    direction: "expense",
    description_raw: "Compra demo",
    description_normalized: "COMPRA DEMO",
    merchant_name: "Demo",
    creditor_name: "Demo",
    debtor_name: null,
    counterparty_iban_masked: null,
    bank_transaction_code: null,
    merchant_category_code: null,
    balance_after: null,
    category_auto: null,
    subcategory_auto: null,
    source_raw_file: null,
    raw_fingerprint: "raw-one",
    ...overrides
  };
}

describe("transaction idempotency", () => {
  it.each([
    {
      field: "booking_date" as const,
      enrichedValue: "2026-07-25",
      initial: { booking_date: null, value_date: "2026-07-24" }
    },
    {
      field: "value_date" as const,
      enrichedValue: "2026-07-25",
      initial: { booking_date: "2026-07-24", value_date: null }
    }
  ])("updates an id-less fallback movement when $field is enriched", ({
    field,
    enrichedValue,
    initial
  }) => {
    const database = createDatabase(":memory:");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', ?, 1, ?, ?)`
      )
      .run(createId(), now, now);
    const repository = new TransactionRepository(database);

    expect(
      repository.upsert(
        transaction({
          ...initial,
          movement_key: `fallback-without-${field}`,
          fallback_occurrence: 1,
          status: "booked"
        })
      )
    ).toBe("inserted");
    expect(
      repository.upsert(
        transaction({
          ...initial,
          [field]: enrichedValue,
          movement_key: `fallback-with-${field}`,
          fallback_occurrence: 1,
          status: "booked",
          raw_fingerprint: `raw-enriched-${field}`
        })
      )
    ).toBe("updated");
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count, booking_date, value_date
           FROM transactions`
        )
        .get()
    ).toEqual({
      count: 1,
      booking_date:
        field === "booking_date" ? enrichedValue : initial.booking_date,
      value_date: field === "value_date" ? enrichedValue : initial.value_date
    });

    expect(
      repository.upsert(
        transaction({
          ...initial,
          movement_key: `fallback-without-${field}`,
          fallback_occurrence: 1,
          status: "booked",
          raw_fingerprint: `raw-${field}-omitted-again`
        })
      )
    ).toBe("updated");
    expect(
      database
        .prepare("SELECT booking_date, value_date FROM transactions")
        .get()
    ).toEqual({
      booking_date:
        field === "booking_date" ? enrichedValue : initial.booking_date,
      value_date: field === "value_date" ? enrichedValue : initial.value_date
    });
    database.close();
  });

  it("updates an id-less fallback movement when its transaction date is enriched", () => {
    const database = createDatabase(":memory:");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', ?, 1, ?, ?)`
      )
      .run(createId(), now, now);
    const repository = new TransactionRepository(database);

    expect(
      repository.upsert(
        transaction({
          movement_key: "fallback-without-date",
          fallback_occurrence: 1,
          status: "booked"
        })
      )
    ).toBe("inserted");
    expect(
      repository.upsert(
        transaction({
          movement_key: "fallback-with-date",
          fallback_occurrence: 1,
          status: "booked",
          transaction_datetime: "2026-07-24T12:34:56.000Z",
          raw_fingerprint: "raw-enriched"
        })
      )
    ).toBe("updated");

    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count, movement_key, transaction_datetime
           FROM transactions`
        )
        .get()
    ).toEqual({
      count: 1,
      movement_key: "fallback-without-date",
      transaction_datetime: "2026-07-24T12:34:56.000Z"
    });

    expect(
      repository.upsert(
        transaction({
          movement_key: "fallback-without-date",
          fallback_occurrence: 1,
          status: "booked",
          raw_fingerprint: "raw-date-omitted-again"
        })
      )
    ).toBe("updated");
    expect(
      database
        .prepare("SELECT transaction_datetime FROM transactions")
        .get()
    ).toEqual({ transaction_datetime: "2026-07-24T12:34:56.000Z" });
    database.close();
  });

  it("deduplicates identical input and reconciles pending to booked", () => {
    const database = createDatabase(":memory:");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', ?, 1, ?, ?)`
      )
      .run(createId(), now, now);
    const repository = new TransactionRepository(database);

    expect(repository.upsert(transaction())).toBe("inserted");
    expect(repository.upsert(transaction())).toBe("duplicate");
    expect(
      repository.upsert(
        transaction({
          movement_key: "booked-key",
          status: "booked",
          provider_transaction_id: "provider-id",
          raw_fingerprint: "raw-two"
        })
      )
    ).toBe("reconciled");
    const rows = database
      .prepare("SELECT movement_key, status FROM transactions")
      .all();
    expect(rows).toEqual([{ movement_key: "pending-key", status: "booked" }]);
    database.close();
  });

  it("does not reconcile identical recurring movements outside the date window", () => {
    const database = createDatabase(":memory:");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', ?, 1, ?, ?)`
      )
      .run(createId(), now, now);
    const repository = new TransactionRepository(database, 14);

    expect(repository.upsert(transaction({ booking_date: "2026-01-01" }))).toBe("inserted");
    expect(
      repository.upsert(
        transaction({
          movement_key: "booked-key",
          status: "booked",
          booking_date: "2026-02-01",
          raw_fingerprint: "raw-two"
        })
      )
    ).toBe("inserted");
    const rows = database
      .prepare("SELECT movement_key, status FROM transactions ORDER BY booking_date")
      .all();
    expect(rows).toEqual([
      { movement_key: "pending-key", status: "pending" },
      { movement_key: "booked-key", status: "booked" }
    ]);
    database.close();
  });
});
