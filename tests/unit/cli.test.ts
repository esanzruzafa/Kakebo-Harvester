import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { SyncAlreadyRunningError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SynchronizationLock } from "../../src/sync/sync-runner.js";
import type { SyncService } from "../../src/sync/sync-service.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("CLI synchronization commands", () => {
  it("does not start a standalone sync while another synchronization holds the lock", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-cli-lock-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const syncAccounts = vi.fn().mockResolvedValue(1);
    const lock = new SynchronizationLock(database);
    lock.acquire();

    await expect(
      runCli(["sync-accounts"], {
        config,
        database,
        client: {} as never,
        authorization: {} as never,
        sync: { syncAccounts } as unknown as SyncService,
        logger: { info: vi.fn() } as never
      })
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);

    expect(syncAccounts).not.toHaveBeenCalled();
    lock.release();
    database.close();
  });

  it("does not disconnect a connection while synchronization holds the lock", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-cli-disconnect-lock-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const deleteSession = vi.fn();
    const lock = new SynchronizationLock(database);
    lock.acquire();

    await expect(
      runCli(["disconnect", "--connection", "Demo Bank personal"], {
        config,
        database,
        client: { deleteSession } as never,
        authorization: {} as never,
        sync: {} as SyncService,
        logger: { warn: vi.fn() } as never
      })
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);

    expect(deleteSession).not.toHaveBeenCalled();
    lock.release();
    database.close();
  });
});
