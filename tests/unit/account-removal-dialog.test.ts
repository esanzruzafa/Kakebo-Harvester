import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  createAccountRemovalDialogModel,
  selectedAccountRemovalMode
} from "../../src/desktop/account-removal-dialog.js";
import type { EditableAccount } from "../../src/storage/repositories/account-repository.js";

function account(overrides: Partial<EditableAccount> = {}): EditableAccount {
  return {
    id: "account-1",
    identificationHash: "private-hash",
    bank: "Example Bank",
    connection: "Household connection",
    account: "Daily account",
    masked: "ES** **** 1234",
    currency: "EUR",
    productType: null,
    alias: "Food budget",
    providerActive: true,
    syncEnabled: true,
    exportEnabled: true,
    lastError: null,
    ...overrides
  };
}

describe("account removal dialog", () => {
  it("exposes a safe account identity without an identification hash", () => {
    const model = createAccountRemovalDialogModel(account());

    expect(model.identity).toEqual({
      bank: "Example Bank",
      connection: "Household connection",
      displayName: "Daily account",
      alias: "Food budget",
      maskedIdentifier: "ES** **** 1234"
    });
    expect(JSON.stringify(model)).not.toContain("private-hash");
  });

  it("starts with retained history and treats deletion as a separate explicit choice", () => {
    const model = createAccountRemovalDialogModel(account());

    expect(model.initialMode).toBe("keep-history");
    expect(model.options).toEqual([
      expect.objectContaining({ mode: "keep-history", destructive: false }),
      expect.objectContaining({ mode: "delete-history", destructive: true })
    ]);
    expect(selectedAccountRemovalMode(undefined)).toBe("keep-history");
    expect(selectedAccountRemovalMode("delete-history")).toBe("delete-history");
  });

  it("describes keyboard-reachable radio choices and cancellation", () => {
    const model = createAccountRemovalDialogModel(account());

    expect(model.accessibility).toEqual({
      role: "dialog",
      selectionRole: "radiogroup",
      keyboard: ["Tab", "Space", "Enter", "Escape"]
    });
  });

  it("provides all account-removal text in English and Spanish", () => {
    const translationDictionary = z.record(z.string(), z.string());
    const locales = [
      translationDictionary.parse(
        JSON.parse(
          readFileSync(new URL("../../src/desktop/locales/en.json", import.meta.url), "utf8")
        )
      ),
      translationDictionary.parse(
        JSON.parse(
          readFileSync(new URL("../../src/desktop/locales/es.json", import.meta.url), "utf8")
        )
      )
    ];
    for (const locale of locales) {
      for (const key of [
        "accountRemoval.title",
        "accountRemoval.keepHistory.label",
        "accountRemoval.deleteHistory.label",
        "accountRemoval.deleteHistory.warning",
        "accountRemoval.cancel",
        "accountRemoval.confirm"
      ]) {
        expect(locale[key]).toBeTypeOf("string");
        expect(locale[key]?.trim()).not.toBe("");
      }
    }
  });
});
