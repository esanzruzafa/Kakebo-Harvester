import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAccountSettings } from "../../src/desktop/account-settings.js";
import { SyncAlreadyRunningError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SynchronizationLock } from "../../src/sync/sync-runner.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("account settings synchronization isolation", () => {
  it("does not save account settings while the shared synchronization lock is held", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-settings-"));
    const database = createDatabase(testConfig(root).databasePath);
    const updateSettings = vi.fn();
    const listEditable = vi.fn().mockReturnValue([]);
    const save = vi.fn().mockResolvedValue(undefined);
    const activeSynchronization = new SynchronizationLock(database);
    activeSynchronization.acquire();

    await expect(
      saveAccountSettings({
        database,
        repository: { updateSettings, listEditable },
        store: { save },
        updates: []
      })
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    activeSynchronization.release();
    await expect(
      saveAccountSettings({
        database,
        repository: { updateSettings, listEditable },
        store: { save },
        updates: []
      })
    ).resolves.toEqual([]);
    expect(updateSettings).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    database.close();
  });
});
