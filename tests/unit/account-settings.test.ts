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
  it("restores database settings and releases the lock when snapshot persistence fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-settings-rollback-"));
    const database = createDatabase(testConfig(root).databasePath);
    const previous = {
      id: "account-1",
      identificationHash: "hash",
      bank: "Demo Bank",
      connection: "Demo personal",
      account: "Current account",
      masked: "ES************00",
      currency: "EUR",
      productType: "CACC",
      alias: "Previous alias",
      providerActive: true,
      syncEnabled: true,
      exportEnabled: false,
      lastError: null
    };
    const updated = {
      ...previous,
      alias: "Updated alias",
      syncEnabled: false,
      exportEnabled: true
    };
    const updateSettings = vi.fn();
    const listEditable = vi
      .fn()
      .mockReturnValueOnce([previous])
      .mockReturnValueOnce([updated]);
    const saveError = new Error("Snapshot unavailable.");
    const save = vi.fn().mockRejectedValue(saveError);

    await expect(
      saveAccountSettings({
        database,
        repository: { updateSettings, listEditable },
        store: { save },
        updates: [
          {
            id: updated.id,
            alias: updated.alias,
            syncEnabled: updated.syncEnabled,
            exportEnabled: updated.exportEnabled
          }
        ]
      })
    ).rejects.toBe(saveError);

    expect(updateSettings).toHaveBeenNthCalledWith(1, [
      {
        id: updated.id,
        alias: updated.alias,
        syncEnabled: updated.syncEnabled,
        exportEnabled: updated.exportEnabled
      }
    ]);
    expect(updateSettings).toHaveBeenNthCalledWith(2, [
      {
        id: previous.id,
        alias: previous.alias,
        syncEnabled: previous.syncEnabled,
        exportEnabled: previous.exportEnabled
      }
    ]);
    const releasedLock = new SynchronizationLock(database);
    expect(() => releasedLock.acquire()).not.toThrow();
    releasedLock.release();
    database.close();
  });

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
