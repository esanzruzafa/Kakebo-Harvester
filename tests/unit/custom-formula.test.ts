import { describe, expect, it } from "vitest";
import {
  customFormulaSchema,
  evaluateCustomFormula,
  parseCustomFormula
} from "../../src/export/custom-formula.js";

describe("custom export formulas", () => {
  it("evaluates arithmetic, source values, and approved functions", () => {
    expect(evaluateCustomFormula("amount * 2", { amount: 12 })).toBe(24);
    expect(
      evaluateCustomFormula("upper(description)", { description: "coffee" })
    ).toBe("COFFEE");
    expect(
      evaluateCustomFormula('concat(lower(description), "-", round(amount / 3, 2))', {
        description: "COFFEE",
        amount: 10
      })
    ).toBe("coffee-3.33");
  });

  it("rejects syntax outside the limited expression language", () => {
    expect(() => parseCustomFormula("process.exit(1)")).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse("amount; process.exit(1)")).toThrow(
      /invalid/i
    );
  });
});
