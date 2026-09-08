import { describe, expect, it } from "vitest";
import {
  balancesResponseSchema,
  getSessionResponseSchema,
  sessionResponseSchema,
  startAuthorizationResponseSchema,
  transactionsResponseSchema
} from "../../src/enable-banking/schemas.js";

describe("provider response schemas", () => {
  it("accepts only credential-free HTTPS authorization URLs", () => {
    expect(
      startAuthorizationResponseSchema.parse({
        url: "https://bank.example/authorize?request=123",
        authorization_id: "authorization"
      }).url
    ).toBe("https://bank.example/authorize?request=123");

    expect(() =>
      startAuthorizationResponseSchema.parse({
        url: "http://bank.example/authorize"
      })
    ).toThrow();
    expect(() =>
      startAuthorizationResponseSchema.parse({
        url: "https://user:password@bank.example/authorize"
      })
    ).toThrow();
  });

  it("accepts optional Mock ASPSP account fields with provider-specific shapes", () => {
    const result = sessionResponseSchema.parse({
      session_id: "session",
      accounts: [
        {
          uid: "account",
          account_id: { other: "mock-account-reference" },
          product: { name: "Mock current account" },
          currency: "EUR"
        }
      ]
    });

    expect(result.accounts[0]?.uid).toBe("account");
  });

  it("rejects blank provider account identifiers", () => {
    expect(
      sessionResponseSchema.safeParse({
        session_id: "session",
        accounts: [{ uid: "   " }]
      }).success
    ).toBe(false);
    expect(
      getSessionResponseSchema.safeParse({
        status: "AUTHORIZED",
        accounts: ["\t"],
        accounts_data: [{ uid: "" }]
      }).success
    ).toBe(false);
  });

  it("rejects blank provider session identifiers", () => {
    expect(
      sessionResponseSchema.safeParse({
        session_id: "  ",
        accounts: []
      }).success
    ).toBe(false);
  });

  it("accepts nullable optional balance dates", () => {
    const result = balancesResponseSchema.parse({
      balances: [
        {
          name: "Booked balance",
          balance_amount: { currency: "EUR", amount: "123.45" },
          last_change_date_time: null,
          reference_date: null
        }
      ]
    });

    expect(result.balances).toHaveLength(1);
  });

  it("rejects malformed balances and canonicalizes valid balance decimals", () => {
    expect(() =>
      balancesResponseSchema.parse({
        balances: [
          {
            balance_amount: { currency: "EUR", amount: "N/A" }
          }
        ]
      })
    ).toThrow();

    expect(
      balancesResponseSchema.parse({
        balances: [
          {
            balance_amount: { currency: "EUR", amount: "0012.3400" }
          }
        ]
      }).balances[0]?.balance_amount.amount
    ).toBe("12.34");
  });

  it("accepts nullable optional transaction fields", () => {
    const result = transactionsResponseSchema.parse({
      transactions: [
        {
          entry_reference: null,
          transaction_id: null,
          transaction_amount: { currency: "EUR", amount: "10.00" },
          transaction_date: null,
          note: null,
          merchant_category_code: null,
          creditor: null,
          debtor_account: null,
          bank_transaction_code: null
        }
      ]
    });

    expect(result.transactions).toHaveLength(1);
  });

  it("normalizes transaction currency codes before transaction mapping", () => {
    const result = transactionsResponseSchema.parse({
      transactions: [
        {
          transaction_amount: { currency: " eur ", amount: "10.00" }
        }
      ]
    });

    expect(result.transactions[0]?.transaction_amount.currency).toBe("EUR");
    expect(
      transactionsResponseSchema.safeParse({
        transactions: [
          {
            transaction_amount: { currency: "EURO", amount: "10.00" }
          }
        ]
      }).success
    ).toBe(false);
  });

  it("canonicalizes supported debit and credit indicators and rejects other values", () => {
    expect(
      transactionsResponseSchema.parse({
        transactions: [
          {
            transaction_amount: { currency: "EUR", amount: "10.00" },
            credit_debit_indicator: " dbit "
          }
        ]
      }).transactions[0]?.credit_debit_indicator
    ).toBe("DBIT");
    expect(
      transactionsResponseSchema.safeParse({
        transactions: [
          {
            transaction_amount: { currency: "EUR", amount: "10.00" },
            credit_debit_indicator: "DEBIT"
          }
        ]
      }).success
    ).toBe(false);
  });

  it("canonicalizes transaction statuses before transaction mapping", () => {
    const result = transactionsResponseSchema.parse({
      transactions: [
        {
          transaction_amount: { currency: "EUR", amount: "10.00" },
          status: " pdng "
        }
      ]
    });

    expect(result.transactions[0]?.status).toBe("PDNG");
  });

  it("maps blank transaction statuses to unknown", () => {
    const result = transactionsResponseSchema.parse({
      transactions: [
        {
          transaction_amount: { currency: "EUR", amount: "10.00" },
          status: "   "
        }
      ]
    });

    expect(result.transactions[0]?.status).toBe("unknown");
  });

  it("normalizes valid session expiry timestamps to UTC", () => {
    expect(
      sessionResponseSchema.parse({
        session_id: "session",
        accounts: [],
        access: { valid_until: "2026-10-01T02:00:00+02:00" }
      }).access?.valid_until
    ).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rejects malformed session expiry timestamps", () => {
    expect(
      sessionResponseSchema.safeParse({
        session_id: "session",
        accounts: [],
        access: { valid_until: "not-a-timestamp" }
      }).success
    ).toBe(false);
  });
});
