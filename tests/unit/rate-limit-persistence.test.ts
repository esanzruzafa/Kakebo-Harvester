import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import {
  PsuHeadersUnavailableError,
  RateLimitError
} from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { encryptSecret } from "../../src/utils/crypto.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("bank rate-limit persistence", () => {
  it("stores the provider code and prevents requests until the retry time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"));
    root = await mkdtemp(join(tmpdir(), "kakebo-rate-limit-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, required_psu_headers_json
         ) VALUES (?, 'enable-banking', ?, 'Demo Bank', 'ES', 'personal',
                   'Demo personal', 'AUTHORIZED', ?, '[]')`
      )
      .run("connection", config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext,
           created_at, status
         ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
      )
      .run(
        "session",
        "connection",
        encryptSecret("provider-session", config.sessionEncryptionKey),
        now
      );
    const getSession = vi.fn().mockResolvedValue({
      status: "AUTHORIZED",
      accounts: ["provider-account"]
    });
    const getAccount = vi.fn().mockRejectedValue(
      new RateLimitError(
        "El banco ha alcanzado su límite de consultas.",
        "2026-07-28T16:00:00.000Z",
        [],
        "ASPSP_RATE_LIMIT_EXCEEDED"
      )
    );
    const client = {
      getSession,
      getAccount
    } as unknown as EnableBankingClient;
    const service = new SyncService(config, database, client);

    await expect(service.syncAccounts()).rejects.toMatchObject({
      providerCode: "ASPSP_RATE_LIMIT_EXCEEDED",
      retryAt: "2026-07-28T16:00:00.000Z",
      connectionIds: ["connection"]
    });
    expect(
      database
        .prepare(
          `SELECT error_code, retry_after_at, online_retry_used
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({
      error_code: "ASPSP_RATE_LIMIT_EXCEEDED",
      retry_after_at: "2026-07-28T16:00:00.000Z",
      online_retry_used: 0
    });

    await expect(service.syncAccounts()).rejects.toBeInstanceOf(RateLimitError);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getAccount).toHaveBeenCalledTimes(1);

    await expect(
      service.syncAccounts({
        psuHeaders: {
          userAgent: "Kakebo-Harvester/1.0.0 Electron/43",
          acceptLanguage: "es"
        },
        allowRateLimitOverride: true
      })
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getAccount).toHaveBeenCalledTimes(2);
    expect(
      database
        .prepare(
          `SELECT online_retry_used
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({ online_retry_used: 1 });

    await expect(
      service.syncAccounts({
        psuHeaders: {
          userAgent: "Kakebo-Harvester/1.0.0 Electron/43",
          acceptLanguage: "es"
        },
        allowRateLimitOverride: true
      })
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getAccount).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("rejects an online request when a required PSU header is unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-psu-headers-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, required_psu_headers_json
         ) VALUES (?, 'enable-banking', ?, 'ING', 'ES', 'personal',
                   'ING personal', 'AUTHORIZED', ?,
                   '["psu-ip-address"]')`
      )
      .run("connection", config.appEnv, now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext,
           created_at, status
         ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
      )
      .run(
        "session",
        "connection",
        encryptSecret("provider-session", config.sessionEncryptionKey),
        now
      );
    const getSession = vi.fn();
    const service = new SyncService(
      config,
      database,
      { getSession } as unknown as EnableBankingClient
    );

    await expect(
      service.syncAccounts({
        psuHeaders: {
          userAgent: "Kakebo-Harvester/1.0.0 Electron/43",
          acceptLanguage: "es"
        }
      })
    ).rejects.toBeInstanceOf(PsuHeadersUnavailableError);
    expect(getSession).not.toHaveBeenCalled();
    database.close();
  });

  it("skips only the connection in cooldown and synchronizes other banks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"));
    root = await mkdtemp(join(tmpdir(), "kakebo-rate-limit-isolation-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at, required_psu_headers_json, retry_after_at,
         error_code
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?, 'AUTHORIZED', ?,
                 '[]', ?, ?)`
    );
    insertConnection.run(
      "limited",
      config.appEnv,
      "Limited Bank",
      "Limited personal",
      now,
      "2026-07-28T16:00:00.000Z",
      "ASPSP_RATE_LIMIT_EXCEEDED"
    );
    insertConnection.run(
      "ready",
      config.appEnv,
      "Ready Bank",
      "Ready personal",
      now,
      null,
      null
    );
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext,
         created_at, status
       ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
    );
    insertSession.run(
      "limited-session",
      "limited",
      encryptSecret("limited-provider-session", config.sessionEncryptionKey),
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

    await expect(service.syncAccounts()).resolves.toBe(1);
    expect(getSession).toHaveBeenCalledExactlyOnceWith("ready-provider-session");
    expect(getAccount).toHaveBeenCalledExactlyOnceWith("ready-account", undefined);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM accounts WHERE bank_connection_id = 'limited'")
        .get()
    ).toEqual({ count: 0 });
    database.close();
  });

  it("continues with another bank when a connection first enters cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"));
    root = await mkdtemp(join(tmpdir(), "kakebo-rate-limit-first-response-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at, required_psu_headers_json
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?, 'AUTHORIZED', ?, '[]')`
    );
    insertConnection.run(
      "limited",
      config.appEnv,
      "Limited Bank",
      "Limited personal",
      now
    );
    insertConnection.run(
      "ready",
      config.appEnv,
      "Ready Bank",
      "Ready personal",
      now
    );
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext,
         created_at, status
       ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
    );
    insertSession.run(
      "limited-session",
      "limited",
      encryptSecret("limited-provider-session", config.sessionEncryptionKey),
      now
    );
    insertSession.run(
      "ready-session",
      "ready",
      encryptSecret("ready-provider-session", config.sessionEncryptionKey),
      now
    );
    const getSession = vi.fn().mockImplementation((sessionId: string) =>
      Promise.resolve({
        status: "AUTHORIZED",
        accounts: [
          sessionId === "limited-provider-session"
            ? "limited-account"
            : "ready-account"
        ]
      })
    );
    const getAccount = vi.fn().mockImplementation((accountId: string) => {
      if (accountId === "limited-account") {
        return Promise.reject(
          new RateLimitError(
            "Limit reached.",
            "2026-07-28T16:00:00.000Z",
            [],
            "ASPSP_RATE_LIMIT_EXCEEDED"
          )
        );
      }
      return Promise.resolve({
        uid: accountId,
        identification_hash: "ready-hash",
        name: "Ready account",
        currency: "EUR"
      });
    });
    const service = new SyncService(
      config,
      database,
      { getSession, getAccount } as unknown as EnableBankingClient
    );

    await expect(service.syncAccounts()).resolves.toBe(1);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(
      database
        .prepare(
          `SELECT retry_after_at, online_retry_used
           FROM bank_connections WHERE id = 'limited'`
        )
        .get()
    ).toEqual({
      retry_after_at: "2026-07-28T16:00:00.000Z",
      online_retry_used: 0
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM accounts WHERE bank_connection_id = 'ready'")
        .get()
    ).toEqual({ count: 1 });
    database.close();
  });

  it("retains cooldown after a partial balance success on the same connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"));
    root = await mkdtemp(join(tmpdir(), "kakebo-rate-limit-partial-balances-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const insertConnection = database.prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at, required_psu_headers_json
       ) VALUES (?, 'enable-banking', ?, ?, 'ES', 'personal', ?, 'AUTHORIZED', ?, '[]')`
    );
    insertConnection.run("limited", config.appEnv, "A Bank", "A personal", now);
    insertConnection.run("ready", config.appEnv, "Z Bank", "Z personal", now);
    const insertSession = database.prepare(
      `INSERT INTO provider_sessions (
         id, bank_connection_id, provider_session_id_ciphertext, created_at, status
       ) VALUES (?, ?, ?, ?, 'AUTHORIZED')`
    );
    insertSession.run(
      "limited-session",
      "limited",
      encryptSecret("limited-session", config.sessionEncryptionKey),
      now
    );
    insertSession.run(
      "ready-session",
      "ready",
      encryptSecret("ready-session", config.sessionEncryptionKey),
      now
    );
    const insertAccount = database.prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name, active,
         first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?)`
    );
    insertAccount.run("limited-a", "limited", "limited-a", "A account", now, now);
    insertAccount.run("limited-b", "limited", "limited-b", "B account", now, now);
    insertAccount.run("ready-a", "ready", "ready-a", "Ready account", now, now);
    const getBalances = vi.fn().mockImplementation((accountId: string) => {
      if (accountId === "limited-b") {
        return Promise.reject(
          new RateLimitError(
            "Limit reached.",
            "2026-07-28T16:00:00.000Z",
            [],
            "ASPSP_RATE_LIMIT_EXCEEDED"
          )
        );
      }
      return Promise.resolve({
        balances: [
          { balance_amount: { amount: "1", currency: "EUR" } }
        ]
      });
    });
    const service = new SyncService(
      config,
      database,
      { getBalances } as unknown as EnableBankingClient
    );

    await expect(service.syncBalances()).resolves.toBe(2);
    expect(getBalances).toHaveBeenCalledTimes(3);
    expect(
      database
        .prepare(
          `SELECT retry_after_at, error_code FROM bank_connections
           WHERE id = 'limited'`
        )
        .get()
    ).toEqual({
      retry_after_at: "2026-07-28T16:00:00.000Z",
      error_code: "ASPSP_RATE_LIMIT_EXCEEDED"
    });
    database.close();
  });
});
