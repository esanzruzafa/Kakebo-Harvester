import type { EditableAccount } from "../storage/repositories/account-repository.js";

export type AccountRemovalMode = "keep-history" | "delete-history";

export interface AccountRemovalDialogModel {
  accountId: string;
  identity: {
    bank: string;
    connection: string;
    displayName: string;
    alias: string | null;
    maskedIdentifier: string | null;
  };
  initialMode: AccountRemovalMode;
  options: Array<{
    mode: AccountRemovalMode;
    destructive: boolean;
  }>;
  accessibility: {
    role: "dialog";
    selectionRole: "radiogroup";
    keyboard: ["Tab", "Space", "Enter", "Escape"];
  };
}

export function createAccountRemovalDialogModel(
  account: EditableAccount
): AccountRemovalDialogModel {
  return {
    accountId: account.id,
    identity: {
      bank: account.bank,
      connection: account.connection,
      displayName: account.account,
      alias: account.alias || null,
      maskedIdentifier: account.masked
    },
    initialMode: "keep-history",
    options: [
      { mode: "keep-history", destructive: false },
      { mode: "delete-history", destructive: true }
    ],
    accessibility: {
      role: "dialog",
      selectionRole: "radiogroup",
      keyboard: ["Tab", "Space", "Enter", "Escape"]
    }
  };
}

export function selectedAccountRemovalMode(
  selected: string | undefined
): AccountRemovalMode {
  return selected === "delete-history" ? "delete-history" : "keep-history";
}
