import { describe, expect, it } from "vitest";
import type { StoredAccount } from "../../src/storage/repositories/account-repository.js";
import {
  mapTransaction,
  normalizeDecimal
} from "../../src/transactions/transaction-mapper.js";
import { formatExactCurrencyDecimal } from "../../src/utils/currency.js";

describe("financial amount convention", () => {
  it("formats audit amounts without losing currency precision", () => {
    expect(formatExactCurrencyDecimal("2.675", "KWD", "en")).toContain(
      "2.675"
    );
    expect(formatExactCurrencyDecimal("2675", "JPY", "en")).toContain(
      "2675"
    );
    expect(
      formatExactCurrencyDecimal("9007199254740993.125", "KWD", "en")
    ).toContain("9007199254740993.125");
  });

  it("stores debits as negative exact decimal strings", () => {
    expect(normalizeDecimal("0012.3400", "DBIT")).toEqual({
      amount: "-12.34",
      direction: "expense"
    });
  });

  it("stores credits as positive exact decimal strings", () => {
    expect(normalizeDecimal("-10,50", "CRDT")).toEqual({
      amount: "10.5",
      direction: "income"
    });
  });

  it("canonicalizes equivalent scales before movement keys are generated", () => {
    expect(normalizeDecimal("10.0").amount).toBe("10");
    expect(normalizeDecimal("10.00").amount).toBe("10");
    expect(normalizeDecimal("00010.0000").amount).toBe("10");
    expect(normalizeDecimal("-0.000", "DBIT").amount).toBe("0");

    const account = {
      id: "account",
      bank_connection_id: "connection",
      identification_hash: "stable-account",
      provider_account_id: "provider-account"
    } as StoredAccount;
    const mapAmount = (amount: string) =>
      mapTransaction({
        transaction: {
          transaction_amount: { amount, currency: "EUR" },
          booking_date: "2026-08-21",
          status: "BOOK",
          remittance_information: "Equivalent movement"
        },
        account,
        environment: "sandbox",
        rawPath: null
      });
    const oneDecimal = mapAmount("10.0");
    const threeDecimals = mapAmount("10.000");
    expect(oneDecimal.movement_key).toBe(threeDecimals.movement_key);
    expect(oneDecimal.reconciliation_key).toBe(
      threeDecimals.reconciliation_key
    );

    const secondOccurrence = mapTransaction({
      transaction: {
        transaction_amount: { amount: "10.00", currency: "EUR" },
        booking_date: "2026-08-21",
        status: "BOOK",
        remittance_information: "Equivalent movement"
      },
      account,
      environment: "sandbox",
      rawPath: null,
      fallbackOccurrence: 2
    });
    expect(secondOccurrence.movement_key).not.toBe(oneDecimal.movement_key);
    expect(secondOccurrence.fallback_occurrence).toBe(2);
  });

  it("discards malformed provider dates before storing or keying movements", () => {
    const account = {
      id: "account",
      bank_connection_id: "connection",
      identification_hash: "stable-account",
      provider_account_id: "provider-account"
    } as StoredAccount;
    const baseTransaction = {
      transaction_amount: { amount: "10.00", currency: "EUR" },
      status: "BOOK",
      remittance_information: "Movement with malformed dates"
    };

    const malformed = mapTransaction({
      transaction: {
        ...baseTransaction,
        booking_date: "2026-04-XX",
        value_date: "2026-02-30",
        transaction_date: "not-a-date"
      },
      account,
      environment: "sandbox",
      rawPath: null
    });
    const absent = mapTransaction({
      transaction: baseTransaction,
      account,
      environment: "sandbox",
      rawPath: null
    });

    expect(malformed).toMatchObject({
      booking_date: null,
      value_date: null,
      transaction_datetime: null
    });
    expect(malformed.movement_key).toBe(absent.movement_key);
    expect(malformed.reconciliation_key).toBe(absent.reconciliation_key);
  });

  it("distinguishes ID-less movements that only differ by transaction time", () => {
    const account = {
      id: "account",
      bank_connection_id: "connection",
      identification_hash: "stable-account",
      provider_account_id: "provider-account"
    } as StoredAccount;
    const mapAt = (transactionDate: string) =>
      mapTransaction({
        transaction: {
          transaction_amount: { amount: "10.00", currency: "EUR" },
          status: "BOOK",
          transaction_date: transactionDate,
          remittance_information: "Repeated same-day movement"
        },
        account,
        environment: "sandbox",
        rawPath: null
      });

    expect(mapAt("2026-08-21T08:00:00Z").movement_key).not.toBe(
      mapAt("2026-08-21T18:00:00Z").movement_key
    );
  });

  it("canonicalizes equivalent provider transaction timestamp offsets", () => {
    const account = {
      id: "account",
      bank_connection_id: "connection",
      identification_hash: "stable-account",
      provider_account_id: "provider-account"
    } as StoredAccount;
    const mapAt = (transactionDate: string) =>
      mapTransaction({
        transaction: {
          transaction_amount: { amount: "10.00", currency: "EUR" },
          status: "BOOK",
          transaction_date: transactionDate,
          remittance_information: "Equivalent timestamp"
        },
        account,
        environment: "sandbox",
        rawPath: null
      });

    const offset = mapAt("2026-08-21T10:00:00+02:00");
    const utc = mapAt("2026-08-21T08:00:00Z");
    expect(offset.transaction_datetime).toBe("2026-08-21T08:00:00.000Z");
    expect(offset.movement_key).toBe(utc.movement_key);
  });

  it("retains the provider-local calendar date when a timestamp crosses UTC midnight", () => {
    const account = {
      id: "account",
      bank_connection_id: "connection",
      identification_hash: "stable-account",
      provider_account_id: "provider-account"
    } as StoredAccount;
    const mapped = mapTransaction({
      transaction: {
        transaction_amount: { amount: "10.00", currency: "EUR" },
        status: "BOOK",
        transaction_date: "2026-08-21T00:30:00+02:00",
        remittance_information: "Local-calendar movement"
      },
      account,
      environment: "sandbox",
      rawPath: null
    });

    expect(mapped).toMatchObject({
      booking_date: "2026-08-21",
      transaction_datetime: "2026-08-20T22:30:00.000Z"
    });
  });

  it("does not give zero-value credits and debits the same fallback identity", () => {
    const account = {
      id: "account",
      bank_connection_id: "connection",
      identification_hash: "stable-account",
      provider_account_id: "provider-account"
    } as StoredAccount;
    const mapZero = (creditDebitIndicator: "DBIT" | "CRDT") =>
      mapTransaction({
        transaction: {
          transaction_amount: { amount: "0", currency: "EUR" },
          credit_debit_indicator: creditDebitIndicator,
          booking_date: "2026-08-21",
          status: "BOOK",
          remittance_information: "Zero movement"
        },
        account,
        environment: "sandbox",
        rawPath: null
      });

    expect(mapZero("DBIT").movement_key).not.toBe(mapZero("CRDT").movement_key);
  });

  it("keeps a non-reversible full counterparty identifier for identity matching", () => {
    const account = {
      id: "account",
      bank_connection_id: "connection",
      identification_hash: "stable-account",
      provider_account_id: "provider-account"
    } as StoredAccount;
    const mapCounterparty = (iban: string) =>
      mapTransaction({
        transaction: {
          transaction_amount: { amount: "10", currency: "EUR" },
          credit_debit_indicator: "DBIT",
          booking_date: "2026-08-21",
          status: "BOOK",
          creditor_account: { iban },
          remittance_information: "Counterparty transfer"
        },
        account,
        environment: "sandbox",
        rawPath: null
      });

    const first = mapCounterparty("ES9121000418450200051332");
    const second = mapCounterparty("ES4221000418450200051332");
    expect(first.counterparty_identification_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.counterparty_identification_hash).not.toBe(
      second.counterparty_identification_hash
    );
  });
});
