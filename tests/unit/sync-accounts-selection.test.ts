import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import {
  BankUnavailableError,
  EnableBankingProviderError,
  ReauthorizationRequiredError
} from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { AccountRepository } from "../../src/storage/repositories/account-repository.js";
import { SyncRunner } from "../../src/sync/sync-runner.js";
import type { SyncProgressEvent } from "../../src/sync/sync-runner.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { encryptSecret } from "../../src/utils/crypto.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("account detail synchronization selection", () => {
  it("refreshes the editable accounts snapshot after the accounts step", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-accounts-snapshot-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider-account', 'Fresh account', 1, ?, ?)`
      )
      .run(now, now);
    await writeFile(config.accountsConfigPath, '{"accounts":[{"account":"stale"}]}');

    await new SyncRunner(config, database, {
      syncAccounts: () => Promise.resolve(1)
    } as unknown as SyncService).run({
      steps: ["accounts"],
      dateFrom: "2026-08-01",
      dateTo: "2026-08-20"
    });

    await expect(readFile(config.accountsConfigPath, "utf8")).resolves.toContain(
      "Fresh account"
    );
    database.close();
  });

  it("skips only a connection whose required PSU header is unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-psu-connection-isolation-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at, required_psu_headers_json
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?, 'AUTHORIZED', ?, ?)`
    );
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext, created_at, status
       ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
    );
    insertConnection.run(
      "needs-ip",
      config.appEnv,
      "IP Bank",
      "IP Bank personal",
      now,
      JSON.stringify(["psu-ip-address"])
    );
    insertConnection.run(
      "ready",
      config.appEnv,
      "Ready Bank",
      "Ready Bank personal",
      now,
      JSON.stringify(["psu-user-agent"])
    );
    insertSession.run(
      "needs-ip-session",
      "needs-ip",
      encryptSecret("needs-ip-provider-session", config.sessionEncryptionKey),
      now
    );
    insertSession.run(
      "ready-session",
      "ready",
      encryptSecret("ready-provider-session", config.sessionEncryptionKey),
      now
    );
    const getSession = vi.fn().mockResolvedValue({
      status: "AUTHORIZED",
      accounts: []
    });
    const service = new SyncService(
      config,
      database,
      { getSession } as unknown as EnableBankingClient
    );

    const result = await new SyncRunner(config, database, service).run(
      {
        steps: ["accounts"],
        dateFrom: "2026-08-01",
        dateTo: "2026-08-20"
      },
      { psuHeaders: { userAgent: "Kakebo test" } }
    );

    expect(result).toMatchObject({
      accounts: 0,
      skippedUnavailableConnections: 1
    });
    expect(getSession).toHaveBeenCalledExactlyOnceWith("ready-provider-session");
    database.close();
  });

  it("skips an unauthorized connection while synchronizing an eligible bank", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-partial-reauthorization-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at, reauthorization_required
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?, ?, ?, ?)`
    );
    insertConnection.run(
      "expired",
      config.appEnv,
      "Expired Bank",
      "Expired personal",
      "REAUTHORIZATION_REQUIRED",
      now,
      1
    );
    insertConnection.run(
      "ready",
      config.appEnv,
      "Ready Bank",
      "Ready personal",
      "AUTHORIZED",
      now,
      0
    );
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext,
           created_at, status
         ) VALUES ('ready-session', 'ready', ?, ?, 'AUTHORIZED')`
      )
      .run(
        encryptSecret("ready-provider-session", config.sessionEncryptionKey),
        now
      );
    const getSession = vi.fn().mockResolvedValue({
      status: "AUTHORIZED",
      accounts: ["ready-account"]
    });
    const getAccount = vi.fn().mockResolvedValue({
      uid: "ready-account",
      identification_hash: "ready-hash",
      name: "Ready account",
      currency: "EUR"
    });
    const service = new SyncService(
      config,
      database,
      { getSession, getAccount } as unknown as EnableBankingClient
    );

    const result = await new SyncRunner(config, database, service).run({
      steps: ["accounts"],
      dateFrom: "2026-08-01",
      dateTo: "2026-08-20"
    });

    expect(result).toMatchObject({ accounts: 1, skippedConnections: 1 });
    expect(getSession).toHaveBeenCalledExactlyOnceWith("ready-provider-session");
    expect(getAccount).toHaveBeenCalledExactlyOnceWith(
      "ready-account",
      undefined
    );
    database.close();
  });

  it("does not report a connection as skipped after runtime reauthorization succeeds", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-successful-reauthorization-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, reauthorization_required
         ) VALUES ('connection', 'enable-banking', ?, 'Demo Bank', 'ES',
                   'personal', 'Demo personal', 'AUTHORIZED', ?, 0)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext,
           created_at, status
         ) VALUES ('old-session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("old-provider-session", config.sessionEncryptionKey), now);
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ReauthorizationRequiredError("The provider session has expired.")
      )
      .mockResolvedValueOnce({ status: "AUTHORIZED", accounts: [] });
    const service = new SyncService(
      config,
      database,
      { getSession } as unknown as EnableBankingClient
    );

    const result = await new SyncRunner(config, database, service).run(
      {
        steps: ["accounts"],
        dateFrom: "2026-08-01",
        dateTo: "2026-08-20"
      },
      {
        onReauthorization: (connectionIds) => {
          expect(connectionIds).toEqual(["connection"]);
          database
            .prepare(
              `UPDATE bank_connections SET
                 status = 'AUTHORIZED', reauthorization_required = 0
               WHERE id = 'connection'`
            )
            .run();
          database
            .prepare(
              `INSERT INTO provider_sessions (
                 id, bank_connection_id, provider_session_id_ciphertext,
                 created_at, status
               ) VALUES ('new-session', 'connection', ?, ?, 'AUTHORIZED')`
            )
            .run(
              encryptSecret("new-provider-session", config.sessionEncryptionKey),
              now
            );
          return Promise.resolve();
        }
      }
    );

    expect(result).toEqual({ accounts: 0 });
    expect(getSession).toHaveBeenNthCalledWith(1, "old-provider-session");
    expect(getSession).toHaveBeenNthCalledWith(2, "new-provider-session");
    expect(
      database
        .prepare(
          `SELECT status, error_code
           FROM desktop_runs ORDER BY started_at DESC LIMIT 1`
        )
        .get()
    ).toEqual({ status: "SUCCESS", error_code: null });
    database.close();
  });

  it("isolates a session that expires remotely while synchronizing another bank", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-runtime-reauthorization-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?,
                 'AUTHORIZED', ?)`
    );
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext,
         created_at, status
       ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
    );
    for (const id of ["expired", "ready"] as const) {
      insertConnection.run(
        id,
        config.appEnv,
        `${id} Bank`,
        `${id} personal`,
        now
      );
      insertSession.run(
        `${id}-session`,
        id,
        encryptSecret(`${id}-provider-session`, config.sessionEncryptionKey),
        now
      );
    }
    const getSession = vi.fn((sessionId: string) => {
      if (sessionId === "expired-provider-session") {
        throw new ReauthorizationRequiredError(
          "The provider session has expired.",
          [],
          { providerCode: "RESOURCE_EXPIRED", httpStatus: 403 }
        );
      }
      return { status: "AUTHORIZED", accounts: [] };
    });
    const service = new SyncService(
      config,
      database,
      { getSession } as unknown as EnableBankingClient
    );

    await expect(
      new SyncRunner(config, database, service).run({
        steps: ["accounts"],
        dateFrom: "2026-08-01",
        dateTo: "2026-08-20"
      })
    ).resolves.toMatchObject({ accounts: 0, skippedConnections: 1 });

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(
      database
        .prepare(
          `SELECT status, reauthorization_required, error_code
           FROM bank_connections WHERE id = 'expired'`
        )
        .get()
    ).toEqual({
      status: "REAUTHORIZATION_REQUIRED",
      reauthorization_required: 1,
      error_code: "REAUTHORIZATION_REQUIRED"
    });
    database.close();
  });

  it("skips a temporarily unavailable session while synchronizing another bank", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-partial-session-failure-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?,
                 'AUTHORIZED', ?)`
    );
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext,
         created_at, status
       ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
    );
    for (const id of ["unavailable", "ready"] as const) {
      insertConnection.run(
        id,
        config.appEnv,
        `${id} Bank`,
        `${id} personal`,
        now
      );
      insertSession.run(
        `${id}-session`,
        id,
        encryptSecret(`${id}-provider-session`, config.sessionEncryptionKey),
        now
      );
    }
    const getSession = vi.fn((sessionId: string) => {
      if (sessionId === "unavailable-provider-session") {
        throw new BankUnavailableError("The bank is temporarily unavailable.");
      }
      return { status: "AUTHORIZED", accounts: [] };
    });
    const service = new SyncService(
      config,
      database,
      { getSession } as unknown as EnableBankingClient
    );

    await expect(
      new SyncRunner(config, database, service).run({
        steps: ["accounts", "balances"],
        dateFrom: "2026-08-01",
        dateTo: "2026-08-20"
      })
    ).resolves.toMatchObject({
      accounts: 0,
      balances: 0,
      skippedUnavailableConnections: 1
    });

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(
      database
        .prepare(
          "SELECT error_code FROM bank_connections WHERE id = 'unavailable'"
        )
        .get()
    ).toEqual({ error_code: "BANK_UNAVAILABLE" });
    expect(
      database
        .prepare(
          `SELECT status, error_code
           FROM desktop_runs ORDER BY started_at DESC LIMIT 1`
        )
        .get()
    ).toEqual({
      status: "SUCCESS_WITH_WARNINGS",
      error_code: "SYNC_WARNINGS"
    });
    database.close();
  });

  it("fails when every available session is temporarily unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-full-session-failure-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('unavailable', 'enable-banking', ?, 'Unavailable Bank', 'ES',
                   'personal', 'Unavailable personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext,
           created_at, status
         ) VALUES ('session', 'unavailable', ?, ?, 'AUTHORIZED')`
      )
      .run(
        encryptSecret("unavailable-provider-session", config.sessionEncryptionKey),
        now
      );
    const service = new SyncService(
      config,
      database,
      {
        getSession: vi
          .fn()
          .mockRejectedValue(
            new BankUnavailableError("The bank is temporarily unavailable.")
          )
      } as unknown as EnableBankingClient
    );

    await expect(service.syncAccounts()).rejects.toBeInstanceOf(
      BankUnavailableError
    );
    database.close();
  });

  it("still requests reauthorization when no bank connection is usable", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-full-reauthorization-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, reauthorization_required
         ) VALUES ('expired', 'enable-banking', ?, 'Expired Bank', 'ES',
                   'personal', 'Expired personal', 'REAUTHORIZATION_REQUIRED',
                   ?, 1)`
      )
      .run(config.appEnv, new Date().toISOString());
    const getSession = vi.fn();
    const service = new SyncService(
      config,
      database,
      { getSession } as unknown as EnableBankingClient
    );

    await expect(service.syncAccounts()).rejects.toMatchObject({
      name: ReauthorizationRequiredError.name,
      connectionIds: ["expired"]
    });
    expect(getSession).not.toHaveBeenCalled();
    database.close();
  });

  it("skips an expired provider session before validating PSU metadata", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-expired-provider-session-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at, valid_until
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?, 'AUTHORIZED', ?, ?)`
    );
    insertConnection.run(
      "expired",
      config.appEnv,
      "Expired Bank",
      "Expired personal",
      now,
      future
    );
    insertConnection.run(
      "ready",
      config.appEnv,
      "Ready Bank",
      "Ready personal",
      now,
      future
    );
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext,
         created_at, valid_until, status
       ) VALUES (?, ?, ?, ?, ?, 'AUTHORIZED')`
    );
    insertSession.run(
      "expired-session",
      "expired",
      encryptSecret("expired-provider-session", config.sessionEncryptionKey),
      now,
      past
    );
    insertSession.run(
      "ready-session",
      "ready",
      encryptSecret("ready-provider-session", config.sessionEncryptionKey),
      now,
      future
    );
    const listBanks = vi.fn().mockResolvedValue([
      {
        name: "Ready Bank",
        country: "ES",
        psu_types: ["personal"],
        auth_methods: [],
        required_psu_headers: ["psu-user-agent"]
      }
    ]);
    const getSession = vi.fn().mockResolvedValue({
      status: "AUTHORIZED",
      accounts: []
    });
    const service = new SyncService(
      config,
      database,
      { listBanks, getSession } as unknown as EnableBankingClient
    );

    await expect(
      new SyncRunner(config, database, service).run(
        {
          steps: ["accounts"],
          dateFrom: "2026-08-01",
          dateTo: "2026-08-20"
        },
        { psuHeaders: { userAgent: "Kakebo-Harvester/1.0.0" } }
      )
    ).resolves.toMatchObject({ accounts: 0, skippedConnections: 1 });

    expect(listBanks).toHaveBeenCalledExactlyOnceWith("ES", "personal");
    expect(getSession).toHaveBeenCalledExactlyOnceWith("ready-provider-session");
    expect(
      database
        .prepare(
          "SELECT required_psu_headers_json FROM bank_connections WHERE id = 'expired'"
        )
        .get()
    ).toEqual({ required_psu_headers_json: null });
    database.close();
  });

  it("selects exactly one authorized session when timestamps collide", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-session-tie-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', ?, 'BBVA', 'ES', 'personal',
                   'BBVA personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext, created_at, status
       ) VALUES (?, 'connection', ?, ?, 'AUTHORIZED')`
    );
    insertSession.run(
      "session-z-old",
      encryptSecret("provider-session-old", config.sessionEncryptionKey),
      now
    );
    insertSession.run(
      "session-a-new",
      encryptSecret("provider-session-new", config.sessionEncryptionKey),
      now
    );
    const getSession = vi.fn().mockResolvedValue({
      status: "AUTHORIZED",
      accounts: []
    });
    const client = { getSession } as unknown as EnableBankingClient;

    await expect(new SyncService(config, database, client).syncAccounts()).resolves.toBe(0);

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith("provider-session-new");
    database.close();
  });

  it("does not read or mutate sessions from another environment", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-environment-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const expiredRetry = "2026-01-01T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, retry_after_at
         ) VALUES ('production-connection', 'enable-banking', 'production',
                   'Production Bank', 'ES', 'personal', 'Production personal',
                   'AUTHORIZED', ?, ?)`
      )
      .run(now, expiredRetry);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('production-session', 'production-connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("production-provider-session", config.sessionEncryptionKey), now);
    const getSession = vi.fn();
    const client = { getSession } as unknown as EnableBankingClient;

    await expect(new SyncService(config, database, client).syncAccounts()).resolves.toBe(0);
    await expect(
      new SyncService(config, database, client).syncTransactions(
        "2026-08-01",
        "2026-08-20"
      )
    ).resolves.toMatchObject({ received: 0, inserted: 0 });

    expect(getSession).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `SELECT retry_after_at, last_sync_at
           FROM bank_connections WHERE id = 'production-connection'`
        )
        .get()
    ).toEqual({ retry_after_at: expiredRetry, last_sync_at: null });
    database.close();
  });

  it("skips known disabled accounts but still discovers new accounts", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-accounts-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', ?, 'BBVA', 'ES', 'personal',
                   'BBVA personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("provider-session", config.sessionEncryptionKey), now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name, sync_enabled,
           active, first_seen_at, last_seen_at
         ) VALUES ('closed-account', 'connection', 'closed-provider-account',
                   'Closed account', 0, 1, ?, ?)`
      )
      .run(now, now);

    const getAccount = vi.fn().mockResolvedValue({
      uid: "new-provider-account",
      name: "New account",
      currency: "EUR"
    });
    const client = {
      getSession: vi.fn().mockResolvedValue({
        status: "AUTHORIZED",
        accounts: [
          "closed-provider-account",
          "new-provider-account",
          "new-provider-account"
        ]
      }),
      getAccount
    } as unknown as EnableBankingClient;

    await expect(new SyncService(config, database, client).syncAccounts()).resolves.toBe(1);
    expect(getAccount).toHaveBeenCalledTimes(1);
    expect(getAccount).toHaveBeenCalledWith("new-provider-account", undefined);
    expect(
      database
        .prepare("SELECT sync_enabled FROM accounts WHERE id = 'closed-account'")
        .get()
    ).toEqual({ sync_enabled: 0 });
    database.close();
  });

  it("deactivates accounts omitted by the session and reactivates them if they return", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-session-accounts-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', ?, 'BBVA', 'ES', 'personal',
                   'BBVA personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("provider-session", config.sessionEncryptionKey), now);
    const insertAccount = database.prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name, account_alias,
         active, first_seen_at, last_seen_at
       ) VALUES (?, 'connection', ?, ?, ?, 1, ?, ?)`
    );
    insertAccount.run(
      "returned-account",
      "returned-provider-account",
      "Returned account",
      "Everyday",
      now,
      now
    );
    insertAccount.run(
      "omitted-account",
      "omitted-provider-account",
      "Omitted account",
      "Savings",
      now,
      now
    );
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({
        status: "AUTHORIZED",
        accounts: ["returned-provider-account"]
      })
      .mockResolvedValueOnce({
        status: "AUTHORIZED",
        accounts: ["returned-provider-account", "omitted-provider-account"]
      });
    const getAccount = vi.fn((uid: string) => ({
      uid,
      name: uid,
      currency: "EUR"
    }));
    const client = { getSession, getAccount } as unknown as EnableBankingClient;
    const service = new SyncService(config, database, client);

    await expect(service.syncAccounts()).resolves.toBe(1);
    expect(
      database
        .prepare("SELECT active, account_alias FROM accounts WHERE id = 'omitted-account'")
        .get()
    ).toEqual({ active: 0, account_alias: "Savings" });
    expect(
      new AccountRepository(database).listActive().map((account) => account.id)
    ).toEqual(["returned-account"]);

    await expect(service.syncAccounts()).resolves.toBe(2);
    expect(
      database
        .prepare("SELECT active, account_alias FROM accounts WHERE id = 'omitted-account'")
        .get()
    ).toEqual({ active: 1, account_alias: "Savings" });
    database.close();
  });

  it("records an enabled account failure and skips it after the user continues", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-account-failure-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', ?, 'BBVA', 'ES', 'personal',
                   'BBVA personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("provider-session", config.sessionEncryptionKey), now);
    const insertAccount = database.prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name, sync_enabled,
         active, first_seen_at, last_seen_at
       ) VALUES (?, 'connection', ?, ?, 1, 1, ?, ?)`
    );
    insertAccount.run("closed-account", "closed-provider-account", "Closed account", now, now);
    insertAccount.run("healthy-account", "healthy-provider-account", "Healthy account", now, now);

    const getAccount = vi.fn((accountId: string) => {
      if (accountId === "closed-provider-account") {
        throw new BankUnavailableError(
          "The bank no longer provides this account.",
          undefined,
          { providerCode: "ASPSP_ERROR", httpStatus: 400 }
        );
      }
      return { uid: accountId, name: "Healthy account", currency: "EUR" };
    });
    const getBalances = vi.fn().mockResolvedValue({ balances: [] });
    const getTransactions = vi.fn().mockResolvedValue({
      transactions: [],
      continuation_key: null
    });
    const client = {
      getSession: vi.fn().mockResolvedValue({
        status: "AUTHORIZED",
        accounts: ["closed-provider-account", "healthy-provider-account"]
      }),
      getAccount,
      getBalances,
      getTransactions
    } as unknown as EnableBankingClient;
    const onAccountFailure = vi.fn().mockResolvedValue("continue");
    const service = new SyncService(config, database, client);
    const progressEvents: SyncProgressEvent[] = [];
    const onProgress = (event: SyncProgressEvent): void => {
      progressEvents.push(event);
    };

    await expect(
      new SyncRunner(config, database, service).run(
        {
          steps: ["accounts", "balances", "transactions"],
          dateFrom: "2026-08-01",
          dateTo: "2026-08-20"
        },
        { onAccountFailure, onProgress }
      )
    ).resolves.toMatchObject({
      accounts: 1,
      balances: 0,
      transactions: { received: 0 }
    });

    expect(getAccount).toHaveBeenCalledTimes(2);
    expect(getBalances).toHaveBeenCalledTimes(1);
    expect(getTransactions).toHaveBeenCalledTimes(1);
    expect(onAccountFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "closed-account",
        accountName: "Closed account",
        bankName: "BBVA",
        phase: "accounts",
        code: "ASPSP_ERROR"
      })
    );
    const accountFailureProgress = progressEvents.find(
      (event) => event.type === "account-failed"
    );
    expect(accountFailureProgress?.accountFailure?.accountId).toBe("closed-account");
    const lastError = database
      .prepare<
        [],
        { last_error_code: string; last_error_message_safe: string }
      >(
        `SELECT last_error_code, last_error_message_safe
         FROM accounts WHERE id = 'closed-account'`
      )
      .get();
    expect(lastError).toEqual({
      last_error_code: "ASPSP_ERROR",
      last_error_message_safe: "The bank no longer provides this account."
    });
    database.close();
  });

  it("does not mark a connection as synchronized when every account fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-failed-last-sync-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', ?, 'Demo Bank', 'ES',
                   'personal', 'Demo personal', 'AUTHORIZED', ?)`
      )
      .run(config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext,
           created_at, status
         ) VALUES ('session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("provider-session", config.sessionEncryptionKey), now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name, sync_enabled,
           active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider-account', 'Account', 1,
                   1, ?, ?)`
      )
      .run(now, now);
    const getTransactions = vi.fn().mockRejectedValue(
      new EnableBankingProviderError(
        "The account resource has expired.",
        "RESOURCE_EXPIRED",
        403
      )
    );
    const service = new SyncService(
      config,
      database,
      { getTransactions } as unknown as EnableBankingClient
    );

    await expect(
      service.syncTransactions("2026-08-01", "2026-08-20", {
        skippedAccountIds: new Set<string>(),
        skippedConnectionIds: new Set<string>(),
        onAccountFailure: () => Promise.resolve("continue")
      })
    ).resolves.toMatchObject({ received: 0, inserted: 0 });

    expect(
      database
        .prepare(
          `SELECT last_sync_at FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({ last_sync_at: null });
    expect(
      database
        .prepare(
          `SELECT last_error_code FROM accounts WHERE id = 'account'`
        )
        .get()
    ).toEqual({ last_error_code: "RESOURCE_EXPIRED" });
    database.close();
  });
});
