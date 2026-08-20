import { describe, expect, it } from "vitest";
import { maskIdentifier, normalizeText, safeMessage } from "../../src/utils/text.js";

describe("text utilities", () => {
  it("normalizes accents, whitespace and case", () => {
    expect(normalizeText("  Café   con LEche ")).toBe("CAFE CON LECHE");
  });

  it("masks account identifiers", () => {
    expect(maskIdentifier("ES12 1234 5678 9012 3456")).toBe("ES************56");
  });

  it("redacts tokens and IBANs from user-facing errors", () => {
    expect(
      safeMessage(
        "Authorization: Bearer abc.def.ghi iban ES1212345678901234567890 code=secret"
      )
    ).not.toMatch(/abc|ES1212|secret/);
  });
});
