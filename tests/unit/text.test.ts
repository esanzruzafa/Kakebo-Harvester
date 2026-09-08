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
    const message = safeMessage(
      'Authorization: Bearer abc.def.ghi iban ES1212345678901234567890 lowercase es1212345678901234567890 code=secret&state=csrf-secret {"session_id":"session-secret","refresh_token":"refresh-secret"}'
    );

    expect(message).not.toMatch(
      /abc|ES1212|es1212|csrf-secret|session-secret|refresh-secret|code=secret/u
    );
  });

  it("redacts IBANs formatted with spaces or hyphens from user-facing errors", () => {
    const message = safeMessage(
      "Provider error for ES91 2100-0418 4502-0005 1332 and es91-2100 0418-4502 0005-1332"
    );

    expect(message).not.toMatch(/ES91|2100|1332/iu);
    expect(message).toContain("[MASKED_ACCOUNT]");
  });
});
