import { describe, expect, it, vi } from "vitest";
import {
  assertTrustedDesktopRequest,
  commitAccountRemovalWithSnapshot,
  executeAccountRemovalRequest,
  parseAccountRemovalRequest,
  registerAccountRemovalHandler,
  runAccountRemovalWithSnapshot
} from "../../src/desktop/account-removal-request.js";
import { cleanupRawFiles } from "../../src/storage/account-removal.js";

describe("account removal desktop request", () => {
  it.each([
    { id: "", mode: "keep-history" },
    { id: "   ", mode: "delete-history" },
    { id: "account-1", mode: "delete-all" },
    { id: "account-1", mode: "keep-history", extra: true }
  ])("rejects malformed request %# before an account operation begins", (request) => {
    expect(() => parseAccountRemovalRequest(request)).toThrow();
  });

  it("rejects a request that is not from the current desktop window", () => {
    expect(() =>
      assertTrustedDesktopRequest({
        expectedSenderId: 4,
        expectedUrl: "file:///kakebo/index.html",
        senderId: 9,
        senderUrl: "file:///kakebo/index.html",
        closing: false
      })
    ).toThrow("Rejected IPC request from an untrusted renderer.");
  });

  it("blocks removal while a tracked account operation is active", async () => {
    const remove = vi.fn();

    await expect(
      executeAccountRemovalRequest({
        request: { id: "account-1", mode: "keep-history" },
        hasActiveOperation: () => true,
        remove
      })
    ).rejects.toThrow("Wait for the current account operation to finish");

    expect(remove).not.toHaveBeenCalled();
  });

  it("passes a validated request to the local operation only", async () => {
    const remove = vi.fn().mockResolvedValue({ status: "hidden" });

    await expect(
      executeAccountRemovalRequest({
        request: { id: " account-1 ", mode: "keep-history" },
        hasActiveOperation: () => false,
        remove
      })
    ).resolves.toEqual({ status: "hidden" });

    expect(remove).toHaveBeenCalledWith({
      id: "account-1",
      mode: "keep-history"
    });
  });

  it("registers a guarded handler that locks removal and refreshes the renderer state", async () => {
    let handler:
      | ((event: { sender: string }, input: unknown) => Promise<unknown>)
      | undefined;
    const events: string[] = [];
    const removal = { status: "hidden" };
    const refreshed = { accounts: [] };

    registerAccountRemovalHandler<
      { sender: string },
      { status: string },
      { accounts: never[] }
    >({
      register: (channel, value) => {
        expect(channel).toBe("accounts:remove");
        handler = value;
      },
      assertTrustedSender: (event) => expect(event.sender).toBe("main-window"),
      hasActiveOperation: () => false,
      trackOperation: async (operation) => {
        events.push("tracked");
        return await operation;
      },
      withSynchronizationLock: async (operation) => {
        events.push("locked");
        return await operation();
      },
      remove: async (request) =>
        await runAccountRemovalWithSnapshot({
          previousSnapshot: [{ id: request.id }],
          nextSnapshot: [],
          saveSnapshot: (snapshot) => {
            events.push(`snapshot:${snapshot.length}`);
            return Promise.resolve();
          },
          remove: () => {
            events.push(`removed:${request.id}`);
            return Promise.resolve(removal);
          }
        }),
      refresh: (result) => {
        events.push(`refreshed:${result.status}`);
        return Promise.resolve(refreshed);
      }
    });

    await expect(
      handler?.({ sender: "main-window" }, {
        id: "account-1",
        mode: "keep-history"
      })
    ).resolves.toEqual({ removal, bootstrap: refreshed });
    expect(events).toEqual([
      "locked",
      "snapshot:0",
      "tracked",
      "removed:account-1",
      "refreshed:hidden"
    ]);
  });

  it("does not acquire the lock when another tracked operation is active", async () => {
    let handler:
      | ((event: unknown, input: unknown) => Promise<unknown>)
      | undefined;
    const withSynchronizationLock = vi.fn();
    const remove = vi.fn();

    registerAccountRemovalHandler<unknown, unknown, { accounts: never[] }>({
      register: (_channel, value) => {
        handler = value;
      },
      assertTrustedSender: () => undefined,
      hasActiveOperation: () => true,
      trackOperation: async (operation) => await operation,
      withSynchronizationLock,
      remove,
      refresh: () => Promise.resolve({ accounts: [] })
    });

    await expect(
      handler?.({}, { id: "account-1", mode: "delete-history" })
    ).rejects.toThrow("Wait for the current account operation to finish");
    expect(withSynchronizationLock).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns a safe snapshot error from the registered handler without starting removal", async () => {
    let handler:
      | ((event: unknown, input: unknown) => Promise<unknown>)
      | undefined;
    const removeLocalData = vi.fn();

    registerAccountRemovalHandler<unknown, { status: string }, { accounts: never[] }>({
      register: (_channel, value) => {
        handler = value;
      },
      assertTrustedSender: () => undefined,
      hasActiveOperation: () => false,
      trackOperation: async (operation) => await operation,
      withSynchronizationLock: async (operation) => await operation(),
      remove: async () =>
        await runAccountRemovalWithSnapshot({
          previousSnapshot: [{ id: "account-1" }],
          nextSnapshot: [],
          saveSnapshot: () => Promise.reject(new Error("Private path details")),
          remove: removeLocalData
        }),
      refresh: () => Promise.resolve({ accounts: [] })
    });

    await expect(
      handler?.({}, { id: "account-1", mode: "delete-history" })
    ).rejects.toThrow("Could not save the local account snapshot.");
    expect(removeLocalData).not.toHaveBeenCalled();
  });

  it("keeps the local database operation unstarted when the next account snapshot cannot be saved", async () => {
    const remove = vi.fn();
    const saveSnapshot = vi.fn().mockRejectedValue(new Error("Snapshot unavailable."));

    await expect(
      runAccountRemovalWithSnapshot({
        previousSnapshot: [{ id: "account-1" }],
        nextSnapshot: [],
        saveSnapshot,
        remove
      })
    ).rejects.toThrow("Could not save the local account snapshot.");

    expect(saveSnapshot).toHaveBeenCalledWith([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("restores the prior snapshot when the local database operation fails after snapshot preparation", async () => {
    const saveSnapshot = vi.fn().mockResolvedValue(undefined);
    const removalError = new Error("Database write failed.");

    await expect(
      runAccountRemovalWithSnapshot({
        previousSnapshot: [{ id: "account-1" }],
        nextSnapshot: [],
        saveSnapshot,
        remove: vi.fn().mockRejectedValue(removalError)
      })
    ).rejects.toBe(removalError);

    expect(saveSnapshot).toHaveBeenNthCalledWith(1, []);
    expect(saveSnapshot).toHaveBeenNthCalledWith(2, [{ id: "account-1" }]);
  });

  it("keeps the prospective snapshot when post-purge raw ownership lookup becomes a safe warning", async () => {
    const saveSnapshot = vi.fn().mockResolvedValue(undefined);

    const result = await runAccountRemovalWithSnapshot({
      previousSnapshot: [{ id: "account-1" }],
      nextSnapshot: [],
      saveSnapshot,
      remove: async () => ({
        status: "deleted",
        rawCleanup: await cleanupRawFiles(
          ["C:/safe/raw.json"],
          "C:/safe",
          () => {
            throw new Error("Post-purge ownership lookup failed");
          },
          {
            lstat: () => Promise.resolve({ isSymbolicLink: () => false, isFile: () => true }),
            unlink: () => Promise.resolve()
          }
        )
      })
    });

    expect(result).toEqual({
      status: "deleted",
      rawCleanup: { removed: 0, warnings: ["cleanup-failed"] }
    });
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenCalledWith([]);
  });

  it("writes the account snapshot only after the local database change and finalizes afterward", async () => {
    const events: string[] = [];

    await expect(
      commitAccountRemovalWithSnapshot({
        previousSnapshot: [{ id: "account-1" }],
        nextSnapshot: [],
        saveSnapshot: (snapshot) => {
          events.push(`snapshot:${snapshot.length}`);
          return Promise.resolve();
        },
        begin: () => {
          events.push("database");
          return Promise.resolve({
            finalize: () => {
              events.push("finalize");
              return Promise.resolve({ status: "deleted" });
            },
            rollback: () => events.push("rollback")
          });
        }
      })
    ).resolves.toEqual({ status: "deleted" });
    expect(events).toEqual(["database", "snapshot:0", "finalize"]);
  });

  it("retains the prior snapshot when the local change fails before commit", async () => {
    const saveSnapshot = vi.fn();

    await expect(
      commitAccountRemovalWithSnapshot({
        previousSnapshot: [{ id: "account-1" }],
        nextSnapshot: [],
        saveSnapshot,
        begin: () => Promise.reject(new Error("Database constraint failure"))
      })
    ).rejects.toThrow("Database constraint failure");
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it("rolls back the local database change and restores the prior snapshot when the post-change write fails", async () => {
    const events: string[] = [];
    let attempts = 0;

    await expect(
      commitAccountRemovalWithSnapshot({
        previousSnapshot: [{ id: "account-1" }],
        nextSnapshot: [],
        saveSnapshot: (snapshot) => {
          attempts += 1;
          events.push(`snapshot:${snapshot.length}`);
          return attempts === 1
            ? Promise.reject(new Error("Snapshot disk failure"))
            : Promise.resolve();
        },
        begin: () => {
          events.push("database");
          return Promise.resolve({
            finalize: () => Promise.resolve({ status: "deleted" }),
            rollback: () => events.push("rollback")
          });
        }
      })
    ).rejects.toThrow("Could not save the local account snapshot.");
    expect(events).toEqual(["database", "snapshot:0", "rollback", "snapshot:1"]);
  });
});
