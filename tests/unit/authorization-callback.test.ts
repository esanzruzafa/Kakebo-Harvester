import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationCompletionResult } from "../../src/auth/authorization-service.js";
import { completeDesktopAuthorization } from "../../src/desktop/authorization-callback.js";
import { SyncAlreadyRunningError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SynchronizationLock } from "../../src/sync/sync-runner.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const authorized: AuthorizationCompletionResult = {
  connectionId: "connection",
  bankName: "Demo Bank",
  status: "authorized"
};

describe("desktop authorization callback isolation", () => {
  it("uses the coordinator's existing lock for its active authorization", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-active-callback-"));
    const database = createDatabase(testConfig(root).databasePath);
    const activeLock = new SynchronizationLock(database);
    activeLock.acquire();
    const complete = vi.fn().mockResolvedValue(authorized);

    await expect(
      completeDesktopAuthorization({
        database,
        authorization: {
          pendingConnectionId: () => "connection",
          complete
        },
        isConnectionInProgress: (connectionId) => connectionId === "connection",
        callback: { state: "state", code: "code" }
      })
    ).resolves.toEqual(authorized);
    expect(complete).toHaveBeenCalledOnce();
    activeLock.release();
    database.close();
  });

  it("rejects an unsolicited callback while another process owns the lock", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-unsolicited-callback-"));
    const database = createDatabase(testConfig(root).databasePath);
    const activeLock = new SynchronizationLock(database);
    activeLock.acquire();
    const complete = vi.fn().mockResolvedValue(authorized);

    await expect(
      completeDesktopAuthorization({
        database,
        authorization: {
          pendingConnectionId: () => "connection",
          complete
        },
        isConnectionInProgress: () => false,
        callback: { state: "state", code: "code" }
      })
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    expect(complete).not.toHaveBeenCalled();
    activeLock.release();
    database.close();
  });

  it("releases the acquired lock after an unsolicited callback", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-callback-release-"));
    const database = createDatabase(testConfig(root).databasePath);

    await completeDesktopAuthorization({
      database,
      authorization: {
        pendingConnectionId: () => "connection",
        complete: vi.fn().mockResolvedValue(authorized)
      },
      isConnectionInProgress: () => false,
      callback: { state: "state", code: "code" }
    });

    const nextLock = new SynchronizationLock(database);
    expect(() => nextLock.acquire()).not.toThrow();
    nextLock.release();
    database.close();
  });

  it("releases the acquired lock when unsolicited completion fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-callback-failure-"));
    const database = createDatabase(testConfig(root).databasePath);

    await expect(
      completeDesktopAuthorization({
        database,
        authorization: {
          pendingConnectionId: () => "connection",
          complete: vi.fn().mockRejectedValue(new Error("Invalid callback"))
        },
        isConnectionInProgress: () => false,
        callback: { state: "state", code: "code" }
      })
    ).rejects.toThrow("Invalid callback");

    const nextLock = new SynchronizationLock(database);
    expect(() => nextLock.acquire()).not.toThrow();
    nextLock.release();
    database.close();
  });
});
