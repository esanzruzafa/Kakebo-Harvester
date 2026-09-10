import type { SqliteDatabase } from "../storage/database.js";
import type {
  AccountSettingsUpdate,
  EditableAccount
} from "../storage/repositories/account-repository.js";
import { SynchronizationLock } from "../sync/sync-runner.js";

interface AccountSettingsRepository {
  updateSettings(updates: AccountSettingsUpdate[]): void;
  listEditable(): EditableAccount[];
}

interface AccountSettingsStore {
  save(accounts: EditableAccount[]): Promise<void>;
}

export async function saveAccountSettings(input: {
  database: SqliteDatabase;
  repository: AccountSettingsRepository;
  store: AccountSettingsStore;
  updates: AccountSettingsUpdate[];
}): Promise<EditableAccount[]> {
  const lock = new SynchronizationLock(input.database);
  lock.acquire();
  try {
    const previous = input.repository.listEditable();
    try {
      input.repository.updateSettings(input.updates);
      const saved = input.repository.listEditable();
      await input.store.save(saved);
      return saved;
    } catch (error) {
      try {
        input.repository.updateSettings(
          previous.map((account) => ({
            id: account.id,
            alias: account.alias,
            syncEnabled: account.syncEnabled,
            exportEnabled: account.exportEnabled
          }))
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Account settings could not be saved or rolled back."
        );
      }
      throw error;
    }
  } finally {
    lock.release();
  }
}
