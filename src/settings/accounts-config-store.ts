import type { EditableAccount } from "../storage/repositories/account-repository.js";
import { writeJsonAtomically } from "./atomic-json-file.js";

interface AccountsConfigFile {
  version: 1;
  accounts: Array<{
    identificationHash: string | null;
    bank: string;
    account: string;
    masked: string | null;
    alias: string;
    syncEnabled: boolean;
    exportEnabled: boolean;
  }>;
}

export class AccountsConfigStore {
  public constructor(private readonly path: string) {}

  public async save(accounts: EditableAccount[]): Promise<void> {
    const content: AccountsConfigFile = {
      version: 1,
      accounts: accounts.map((account) => ({
        identificationHash: account.identificationHash,
        bank: account.bank,
        account: account.account,
        masked: account.masked,
        alias: account.alias,
        syncEnabled: account.syncEnabled,
        exportEnabled: account.exportEnabled
      }))
    };
    await writeJsonAtomically(this.path, content);
  }
}
