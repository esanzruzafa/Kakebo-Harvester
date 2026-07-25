import { describe, expect, it } from "vitest";
import { sessionResponseSchema } from "../../src/enable-banking/schemas.js";

describe("provider response schemas", () => {
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

  it("accepts nullable optional balance dates", async () => {
    const { balancesResponseSchema } = await import(
      "../../src/enable-banking/schemas.js"
    );
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
});
