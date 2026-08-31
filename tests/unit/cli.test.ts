import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runCli,
  serializedAuthorizationCompleter
} from "../../src/cli.js";
import { SyncAlreadyRunningError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SynchronizationLock } from "../../src/sync/sync-runner.js";
import type {
  SyncExecutionContext,
  SyncService
} from "../../src/sync/sync-service.js";
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

  it("reports skipped bank connections for standalone synchronization commands", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-cli-warnings-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const syncAccounts = vi.fn().mockImplementation((context: SyncExecutionContext) => {
      context.skippedAuthorizationConnectionIds = new Set(["authorization"]);
      context.skippedRateLimitConnectionIds = new Set(["limited"]);
      context.skippedUnavailableConnectionIds = new Set(["unavailable"]);
      return Promise.resolve(2);
    });

    await runCli(["sync-accounts"], {
      config,
      database,
      client: {} as never,
      authorization: {} as never,
      sync: { syncAccounts } as unknown as SyncService,
      logger: { info: vi.fn() } as never
    });

    expect(warning).toHaveBeenCalledWith(
      "Warning: 1 bank connection(s) were skipped pending authorization."
    );
    expect(warning).toHaveBeenCalledWith(
      "Warning: 1 bank connection(s) were skipped because a request limit is active."
    );
    expect(warning).toHaveBeenCalledWith(
      "Warning: 1 bank connection(s) were skipped because the bank is temporarily unavailable."
    );
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

  it("does not start or complete authorization while synchronization holds the lock", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-cli-authorization-lock-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const connect = vi.fn();
    const complete = vi.fn();
    const lock = new SynchronizationLock(database);
    lock.acquire();

    await expect(
      runCli(["connect", "--bank", "Demo Bank"], {
        config,
        database,
        client: {} as never,
        authorization: { connect } as never,
        sync: {} as SyncService,
        logger: {} as never
      })
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    await expect(
      serializedAuthorizationCompleter(
        database,
        { complete } as never
      ).complete({ state: "state", code: "code" })
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);

    expect(connect).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    lock.release();
    database.close();
  });
});
