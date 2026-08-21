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
    input.repository.updateSettings(input.updates);
    const saved = input.repository.listEditable();
    await input.store.save(saved);
    return saved;
  } finally {
    lock.release();
  }
}
