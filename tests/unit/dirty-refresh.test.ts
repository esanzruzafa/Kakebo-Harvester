import { describe, expect, it } from "vitest";
import { mergeEditableDrafts } from "../../src/desktop/dirty-refresh.js";
import type { EditableAccount } from "../../src/storage/repositories/account-repository.js";

function account(id: string, alias: string): EditableAccount {
  return {
    id,
    identificationHash: null,
    bank: "Bank",
    connection: "Connection",
    account: `Account ${id}`,
    masked: null,
    currency: "EUR",
    productType: null,
    alias,
    providerActive: true,
    syncEnabled: true,
    exportEnabled: true,
    lastError: null
  };
}

describe("dirty desktop refresh", () => {
  it("preserves editable account values while retaining accounts discovered by the refresh", () => {
    const fresh = {
      accounts: [account("existing", "Server alias"), account("new", "")],
      cardImportProfiles: [],
      exclusions: [],
      rules: [],
      categories: [],
      exportSettings: {
        format: "xlsx" as const,
        csv: {
          fieldSeparator: "," as const,
          decimalSeparator: "." as const,
          dateFormat: "yyyy-mm-dd" as const,
          includeBom: true
        },
        columns: []
      }
    };

    const merged = mergeEditableDrafts(fresh, {
      accounts: [
        {
          ...account("existing", "Unsaved alias"),
          syncEnabled: false,
          exportEnabled: false
        }
      ]
    });

    expect(merged.accounts).toEqual([
      expect.objectContaining({
        id: "existing",
        alias: "Unsaved alias",
        syncEnabled: false,
        exportEnabled: false
      }),
      expect.objectContaining({ id: "new" })
    ]);
  });
});
