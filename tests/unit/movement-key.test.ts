import { describe, expect, it } from "vitest";
import { createMovementKey } from "../../src/transactions/movement-key.js";

describe("createMovementKey", () => {
  it("keeps delimiter-containing fallback fields unambiguous", () => {
    const shared = {
      accountStableKey: "account",
      status: "booked",
      bookingDate: "2026-09-09",
      valueDate: null,
      amount: "10",
      currency: "EUR",
      direction: "expense"
    };

    expect(
      createMovementKey({ ...shared, descriptionNormalized: "A|B", counterparty: "C" })
    ).not.toBe(
      createMovementKey({ ...shared, descriptionNormalized: "A", counterparty: "B|C" })
    );
  });
});
