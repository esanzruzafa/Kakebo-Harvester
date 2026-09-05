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
import { encryptSecret } from "../../src/utils/crypto.js";

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

  it.each([
    { command: ["sync-accounts"], steps: ["accounts"] },
    { command: ["sync-balances"], steps: ["balances"] },
    {
      command: ["sync-transactions", "--from", "2026-08-01", "--to", "2026-08-20"],
      steps: ["transactions"]
    }
  ])("records an audited run for $command[0]", async ({ command, steps }) => {
    root = await mkdtemp(join(tmpdir(), "kakebo-cli-audit-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const syncAccounts = vi.fn().mockResolvedValue(2);
    const syncBalances = vi.fn().mockResolvedValue(3);
    const syncTransactions = vi.fn().mockResolvedValue({
      pages: 1,
      received: 1,
      inserted: 1,
      updated: 0,
      duplicates: 0,
      pendingReconciled: 0
    });

    await runCli(command, {
      config,
      database,
      client: {} as never,
      authorization: {} as never,
      sync: {
        syncAccounts,
        syncBalances,
        syncTransactions
      } as unknown as SyncService,
      logger: { info: vi.fn() } as never
    });

    const run = database
      .prepare("SELECT id, status, steps_json FROM desktop_runs")
      .get() as { id: string; status: string; steps_json: string } | undefined;
    expect(run).toMatchObject({ status: "SUCCESS", steps_json: JSON.stringify(steps) });
    if (steps[0] === "balances") {
      expect(syncBalances).toHaveBeenCalledWith(run?.id, expect.any(Object));
    }
    database.close();
  });

  it("ignores a revoked connection when disconnecting an active alias", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-cli-disconnect-revoked-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at
       ) VALUES (?, 'enable-banking', ?, 'Demo Bank', 'ES', 'personal',
                 'Demo Bank personal', ?, ?)`
    );
    insertConnection.run("authorized", config.appEnv, "AUTHORIZED", now);
    insertConnection.run("revoked", config.appEnv, "REVOKED", now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('authorized-session', 'authorized', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("authorized-provider-session", config.sessionEncryptionKey), now);
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    await runCli(["disconnect", "--connection", "Demo Bank personal"], {
      config,
      database,
      client: { deleteSession } as never,
      authorization: {} as never,
      sync: {} as SyncService,
      logger: { warn: vi.fn() } as never
    });

    expect(deleteSession).toHaveBeenCalledWith("authorized-provider-session");
    expect(
      database.prepare("SELECT status FROM bank_connections WHERE id = 'authorized'").get()
    ).toEqual({ status: "REVOKED" });
    database.close();
  });

  it("rejects an ambiguous active connection alias before revoking a consent", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-cli-disconnect-ambiguous-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at
       ) VALUES (?, 'enable-banking', ?, 'Demo Bank', 'ES', 'personal',
                 'Demo Bank personal', 'AUTHORIZED', ?)`
    );
    insertConnection.run("first", config.appEnv, now);
    insertConnection.run("second", config.appEnv, now);
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    await expect(
      runCli(["disconnect", "--connection", "Demo Bank personal"], {
        config,
        database,
        client: { deleteSession } as never,
        authorization: {} as never,
        sync: {} as SyncService,
        logger: { warn: vi.fn() } as never
      })
    ).rejects.toThrow('La conexión "Demo Bank personal" es ambigua.');
    expect(deleteSession).not.toHaveBeenCalled();
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
