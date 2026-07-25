import { describe, expect, it } from "vitest";
import { normalizeDecimal } from "../../src/transactions/transaction-mapper.js";

describe("financial amount convention", () => {
  it("stores debits as negative exact decimal strings", () => {
    expect(normalizeDecimal("0012.3400", "DBIT")).toEqual({
      amount: "-12.3400",
      direction: "expense"
    });
  });

  it("stores credits as positive exact decimal strings", () => {
    expect(normalizeDecimal("-10,50", "CRDT")).toEqual({
      amount: "10.50",
      direction: "income"
    });
  });
});
