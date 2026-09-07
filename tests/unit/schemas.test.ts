import { describe, expect, it } from "vitest";
import {
  balancesResponseSchema,
  sessionResponseSchema,
  startAuthorizationResponseSchema
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

  it("accepts nullable optional transaction fields", async () => {
    const { transactionsResponseSchema } = await import(
      "../../src/enable-banking/schemas.js"
    );
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
