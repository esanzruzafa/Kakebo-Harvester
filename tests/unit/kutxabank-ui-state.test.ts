import { describe, expect, it } from "vitest";

import {
  buildKutxabankSyncInput,
  buildReconciliationConfirmation,
  buildReconciliationUndo,
  createKutxabankSelection,
  isKutxabankSelectionValid,
  refreshKutxabankAfterCommit,
  selectKutxabankConnection,
  selectKutxabankConnectionMode
} from "../../src/desktop/kutxabank-ui-state.js";

const inspection = {
  cards: [
    { selectionToken: "opaque-a", last4: "1234" },
    { selectionToken: "opaque-b", last4: "9876" }
  ],
  connections: [
    {
      id: "connection-a",
      alias: "Kutxabank casa",
      cards: [{ id: "account-a", alias: "Visa", last4: "1234" }]
    },
    {
      id: "connection-b",
      alias: "Kutxabank trabajo",
      cards: [{ id: "account-b", alias: "Compras", last4: null }]
    }
  ]
};

describe("Kutxabank UI selection", () => {
  it("does not infer a bank card or local account from matching last four digits", () => {
    expect(createKutxabankSelection(inspection)).toEqual({
      selectionToken: "",
      connectionMode: "existing",
      connectionId: "connection-a",
      connectionAlias: "",
      accountMode: "existing",
      accountId: "",
      accountAlias: ""
    });
  });

  it("clears the account selection when the local connection changes", () => {
    const selection = createKutxabankSelection(inspection);
    selection.accountId = "account-a";

    expect(selectKutxabankConnection(selection, "connection-b")).toMatchObject({
      connectionId: "connection-b",
      accountId: "",
      accountAlias: ""
    });
  });

  it("requires a new local card when a new connection is selected", () => {
    const selection = {
      ...createKutxabankSelection(inspection),
      accountId: "account-a",
      accountAlias: "Old draft"
    };

    expect(selectKutxabankConnectionMode(selection, "new")).toMatchObject({
      connectionMode: "new",
      connectionId: "",
      accountMode: "new",
      accountId: "",
      accountAlias: ""
    });
  });

  it("builds an existing connection and account request without aliases", () => {
    expect(
      buildKutxabankSyncInput(
        {
          ...createKutxabankSelection(inspection),
          selectionToken: "opaque-b",
          connectionId: "connection-b",
          accountId: "account-b"
        },
        "2026-08-01",
        "2026-09-14"
      )
    ).toEqual({
      selectionToken: "opaque-b",
      connectionId: "connection-b",
      accountId: "account-b",
      dateFrom: "2026-08-01",
      dateTo: "2026-09-14"
    });
  });

  it("requires aliases for new local connection and card choices", () => {
    const selection = {
      ...createKutxabankSelection(inspection),
      selectionToken: "opaque-a",
      connectionMode: "new" as const,
      accountMode: "new" as const
    };

    expect(() =>
      buildKutxabankSyncInput(selection, "2026-08-01", "2026-09-14")
    ).toThrow("connectionAlias");

    selection.connectionAlias = "Personal";
    expect(() =>
      buildKutxabankSyncInput(selection, "2026-08-01", "2026-09-14")
    ).toThrow("accountAlias");
  });

  it("rejects an existing card choice for a new connection", () => {
    expect(() =>
      buildKutxabankSyncInput(
        {
          ...createKutxabankSelection(inspection),
          selectionToken: "opaque-a",
          connectionMode: "new",
          connectionAlias: "Personal",
          accountMode: "existing",
          accountId: "account-a"
        },
        "2026-08-01",
        "2026-09-14"
      )
    ).toThrow("accountAlias");
  });

  it("enables synchronization only for a complete valid selection", () => {
    const selection = {
      ...createKutxabankSelection(inspection),
      selectionToken: "opaque-a",
      connectionId: "connection-a",
      accountId: "account-a"
    };

    expect(isKutxabankSelectionValid(selection, "2026-08-01", "2026-09-14")).toBe(true);
    expect(isKutxabankSelectionValid({ ...selection, accountId: "" }, "2026-08-01", "2026-09-14")).toBe(false);
    expect(isKutxabankSelectionValid(selection, "2026-10-01", "2026-09-14")).toBe(false);
  });

  it("keeps a committed sync successful when either follow-up refresh fails", async () => {
    const calls: string[] = [];
    const failures = await refreshKutxabankAfterCommit(
      () => {
        calls.push("app");
        return Promise.reject(new Error("bootstrap unavailable"));
      },
      () => {
        calls.push("inspection");
        return Promise.reject(new Error("AUTHENTICATION_REQUIRED: private detail"));
      }
    );

    expect(calls).toEqual(["app", "inspection"]);
    expect(failures).toEqual(["app", "inspection"]);
  });

  it("keeps a committed catalog update successful when its app refresh fails", async () => {
    await expect(refreshKutxabankAfterCommit(() => Promise.reject(new Error("cards.json unavailable"))))
      .resolves.toEqual(["app"]);
  });

  it("maps two distinct movement choices to an explicit reconciliation", () => {
    expect(buildReconciliationConfirmation("movement-a", "movement-b", "duplicate")).toEqual({
      firstKey: "movement-a",
      secondKey: "movement-b",
      kind: "duplicate"
    });
    expect(() => buildReconciliationConfirmation("movement-a", "movement-a", "settlement")).toThrow("distinctMovements");
  });

  it("only offers undo for an already reconciled selected movement", () => {
    expect(buildReconciliationUndo({ reference: "reconciliation-a" })).toEqual({
      reference: "reconciliation-a"
    });
    expect(() => buildReconciliationUndo({ reference: null })).toThrow("reconciliationReference");
  });
});
