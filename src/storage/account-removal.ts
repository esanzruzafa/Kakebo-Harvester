import type { SqliteDatabase } from "./database.js";
import { AccountRepository, type AccountPurgeCounts } from "./repositories/account-repository.js";

export type AccountRemovalMode = "keep-history" | "delete-history";

export interface AccountRemovalResult {
  status: "hidden" | "deleted";
  counts: AccountPurgeCounts;
}

export interface RemoveLocalAccountInput {
  database: SqliteDatabase;
  environment: string;
  accountId: string;
  mode: AccountRemovalMode;
}

const emptyCounts: AccountPurgeCounts = {
  accounts: 0,
  balances: 0,
  transactions: 0,
  transactionsRaw: 0,
  synchronizationRuns: 0
};

export function removeLocalAccount(
  input: RemoveLocalAccountInput
): Promise<AccountRemovalResult> {
  return Promise.resolve().then(() => {
    const accounts = new AccountRepository(input.database);
    if (input.mode === "keep-history") {
      if (!accounts.hideLocalAccount(input.accountId, input.environment)) {
        throw new Error("The account does not exist in the active environment.");
      }
      return { status: "hidden", counts: emptyCounts };
    }
    const counts = accounts.purgeLocalAccount(input.accountId, input.environment);
    if (!counts) {
      throw new Error("The account does not exist in the active environment.");
    }
    return { status: "deleted", counts };
  });
}
