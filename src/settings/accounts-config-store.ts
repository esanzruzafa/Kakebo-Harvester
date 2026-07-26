import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EditableAccount } from "../storage/repositories/account-repository.js";

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
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
  }
}
