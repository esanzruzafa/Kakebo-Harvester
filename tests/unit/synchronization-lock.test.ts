import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReauthorizationRequiredError,
  SyncAlreadyRunningError
} from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import {
  SynchronizationLock,
  SyncRunner
} from "../../src/sync/sync-runner.js";
import { DesktopRunRepository } from "../../src/storage/repositories/desktop-run-repository.js";
import type { SyncService } from "../../src/sync/sync-service.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("synchronization lock", () => {
  it("rejects contention and can be reacquired after release", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-lock-"));
    const database = createDatabase(testConfig(root).databasePath);
    const first = new SynchronizationLock(database);
    const second = new SynchronizationLock(database);

    first.acquire();
    expect(() => second.acquire()).toThrow(SyncAlreadyRunningError);
    first.release();
    expect(() => second.acquire()).not.toThrow();
    second.release();
    database.close();
  });

  it("replaces a stale lock", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-lock-stale-"));
    const database = createDatabase(testConfig(root).databasePath);
    database
      .prepare(
        `INSERT INTO application_locks (name, owner, acquired_at)
         VALUES ('synchronization', 'crashed-process', ?)`
      )
      .run(new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString());

    const lock = new SynchronizationLock(database);
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
    database.close();
  });

  it("releases the lock when interactive reauthorization fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-lock-reauthorization-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const sync = {
      syncBalances: vi
        .fn()
        .mockRejectedValue(
          new ReauthorizationRequiredError("Authorization required.", [
            "connection"
          ])
        ),
      listConnectionsRequiringAuthorization: vi
        .fn()
        .mockReturnValue(["connection"])
    } as unknown as SyncService;
    const runner = new SyncRunner(config, database, sync);

    await expect(
      runner.run(
        {
          steps: ["balances"],
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31"
        },
        {
          onReauthorization: vi
            .fn()
            .mockRejectedValue(new Error("Authorization was cancelled."))
        }
      )
    ).rejects.toThrow("Authorization was cancelled.");

    const next = new SynchronizationLock(database);
    expect(() => next.acquire()).not.toThrow();
    next.release();
    database.close();
  });

  it("renews an active lease before stale-lock cleanup", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-lock-renewal-"));
    const database = createDatabase(testConfig(root).databasePath);
    const active = new SynchronizationLock(database);
    active.acquire();
    database
      .prepare(
        `UPDATE application_locks SET acquired_at = ?
         WHERE name = 'synchronization'`
      )
      .run(new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString());

    active.renew();
    const contender = new SynchronizationLock(database);
    expect(() => contender.acquire()).toThrow(SyncAlreadyRunningError);

    active.release();
    database.close();
  });

  it("releases the lock when audit initialization fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-lock-audit-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const runner = new SyncRunner(config, database, {} as SyncService);
    const begin = vi
      .spyOn(DesktopRunRepository.prototype, "begin")
      .mockImplementation(() => {
        throw new Error("Disk full.");
      });

    await expect(
      runner.run({
        steps: ["accounts"],
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31"
      })
    ).rejects.toThrow("Disk full.");

    const next = new SynchronizationLock(database);
    expect(() => next.acquire()).not.toThrow();
    next.release();
    begin.mockRestore();
    database.close();
  });
});
