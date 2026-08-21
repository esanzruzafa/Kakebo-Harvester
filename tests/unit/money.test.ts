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
});
