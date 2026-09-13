import { describe, expect, it } from "vitest";
import {
  customFormulaSchema,
  evaluateCustomFormula,
  parseCustomFormula
} from "../../src/export/custom-formula.js";

describe("custom export formulas", () => {
  it("evaluates arithmetic, source values, and approved functions", () => {
    expect(evaluateCustomFormula("amount * 2", { amount: 12 })).toBe(24);
    expect(evaluateCustomFormula("0.07 * 3", {})).toBe(0.21);
    expect(evaluateCustomFormula("0.1 + 0.2", {})).toBe(0.3);
    expect(evaluateCustomFormula("0.3 - 0.1", {})).toBe(0.2);
    expect(evaluateCustomFormula("0.3 / 0.1", {})).toBe(3);
    expect(evaluateCustomFormula("(10 / 3) + 1", {})).toBeCloseTo(13 / 3);
    expect(evaluateCustomFormula("(10 / 3) * 3", {})).toBe(10);
    expect(evaluateCustomFormula("amount / 10000000", { amount: -1 })).toBe(-0.0000001);
    expect(evaluateCustomFormula("(amount + 1) * 2", { amount: 2 })).toBe(6);
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
    expect(() => customFormulaSchema.parse("9007199254740993 - 9007199254740992")).toThrow(
      /invalid/i
    );
    expect(() => customFormulaSchema.parse("1.0000000000000001")).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse("900719925474099.3")).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse('round("x")')).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse('1 / "x"')).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse('round(coalesce("x", 1))')).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse("round(description)")).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse("description - 1")).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse("1 / 0")).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse("9007199254740991 * 2")).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse('concat(description, 9007199254740991 * 2)')).toThrow(/invalid/i);
    expect(() => customFormulaSchema.parse('coalesce("kept", 1 / 0)')).not.toThrow();
  });

  it("rounds decimal boundaries and short-circuits coalesce", () => {
    expect(evaluateCustomFormula("round(100000.075, 2)", {})).toBe(100000.08);
    expect(evaluateCustomFormula('coalesce(description, 1 / amount)', { description: "kept", amount: 0 })).toBe("kept");
    expect(() => customFormulaSchema.parse("9".repeat(400))).toThrow(/invalid/i);
  });

  it("rejects arithmetic results outside the finite number range", () => {
    const formula = Array.from({ length: 20 }, () => "9007199254740991").join(" * ");
    expect(() => evaluateCustomFormula(formula, {})).toThrow(
      /invalid custom formula value/i
    );
    expect(() => evaluateCustomFormula("9007199254740990 + 3", {})).toThrow(
      /invalid custom formula value/i
    );
    expect(() => evaluateCustomFormula("900719925474099.1 * 3", {})).toThrow(
      /invalid custom formula value/i
    );
    expect(evaluateCustomFormula("0.000000001 / 9007199254740991", {})).toBeGreaterThan(0);
    const underflow = `1${" / 9007199254740991".repeat(21)}`;
    expect(() => evaluateCustomFormula(underflow, {})).toThrow(/invalid custom formula value/i);
  });

  it("rounds negative midpoint values away from zero", () => {
    expect(evaluateCustomFormula("round(1.005, 2)", {})).toBe(1.01);
    expect(evaluateCustomFormula("round(amount, 2)", { amount: -1.005 })).toBe(-1.01);
    expect(evaluateCustomFormula("round(0.0000001, 2)", {})).toBe(0);
    expect(evaluateCustomFormula("round(10, 15)", {})).toBe(10);
    expect(evaluateCustomFormula("round(999999999999999.1, 1)", {})).toBe(999999999999999.1);
  });

});
