import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../../src/auth/authorization-service.js";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { InvalidStateError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { RawStore } from "../../src/storage/raw-store.js";
import { encryptSecret } from "../../src/utils/crypto.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

function ibanIdentificationHash(digest: string): string {
  return `${Buffer.from(
    JSON.stringify([["account", "account_id", "iban"]])
  ).toString("base64")}.${digest}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("bank reauthorization", () => {
  it("rejects a callback created for a different runtime environment", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-callback-environment-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    let authorizationState = "";
    const authorizeSession = vi.fn();
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi.fn((input: { state: string }) => {
        authorizationState = input.state;
        return { url: "https://bank.example/authorize" };
      }),
      authorizeSession
    } as unknown as EnableBankingClient;
    const sandboxService = new AuthorizationService(config, database, client);
    await sandboxService.connect({
      bankSearch: "Demo Bank",
      country: "ES",
      psuType: "personal"
    });
    const productionService = new AuthorizationService(
      {
        ...config,
        appEnv: "production",
        redirectUrl: "https://localhost:8000/callback"
      },
      database,
      client
    );

    await expect(
      productionService.complete({ state: authorizationState, code: "code" })
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect(authorizeSession).not.toHaveBeenCalled();
    database.close();
  });

  it("removes an abandoned new connection without touching established sessions", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-abandoned-connection-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi
        .fn()
        .mockResolvedValue({ url: "https://bank.example/authorize" })
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);
    const started = await service.connect({
      bankSearch: "Demo Bank",
      country: "ES",
      psuType: "personal"
    });

    expect(service.abandonConnection(started.connectionId)).toBe(true);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM bank_connections").get()
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM pending_authorizations").get()
    ).toEqual({ count: 0 });

    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('established', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'established', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("provider-session", config.sessionEncryptionKey), now);

    expect(service.abandonConnection("established")).toBe(false);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM bank_connections").get()
    ).toEqual({ count: 1 });
    database.close();
  });

  it("cleans up an expired pending connection when the service restarts", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-expired-connection-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi
        .fn()
        .mockResolvedValue({ url: "https://bank.example/authorize" })
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);
    await service.connect({
      bankSearch: "Demo Bank",
      country: "ES",
      psuType: "personal"
    });
    database
      .prepare("UPDATE pending_authorizations SET expires_at = ?")
      .run("2000-01-01T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('other-environment', 'enable-banking', 'production',
                   'Production Bank', 'ES', 'personal', 'Production personal',
                   'PENDING_AUTHORIZATION', ?)`
      )
      .run(new Date().toISOString());

    new AuthorizationService(config, database, client);

    expect(
      database.prepare("SELECT id FROM bank_connections").all()
    ).toEqual([{ id: "other-environment" }]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM pending_authorizations").get()
    ).toEqual({ count: 0 });
    database.close();
  });

  it("removes a new pending connection when authorization start fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-authorization-start-failure-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi.fn().mockRejectedValue(new Error("Provider unavailable."))
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);

    await expect(
      service.connect({
        bankSearch: "Demo Bank",
        country: "ES",
        psuType: "personal"
      })
    ).rejects.toThrow("Provider unavailable.");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM bank_connections").get()
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM pending_authorizations").get()
    ).toEqual({ count: 0 });
    database.close();
  });

  it("discards a pending reauthorization state when authorization start fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reauthorization-start-failure-"));
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
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi
        .fn()
        .mockRejectedValue(new Error("Provider unavailable."))
    } as unknown as EnableBankingClient;

    await expect(
      new AuthorizationService(config, database, client).reauthorize(
        "connection"
      )
    ).rejects.toThrow("Provider unavailable.");

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM pending_authorizations").get()
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT status FROM bank_connections WHERE id = 'connection'")
        .get()
    ).toEqual({ status: "AUTHORIZED" });
    database.close();
  });

  it("discards a pending state when persisting a started reauthorization fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reauthorization-persistence-failure-"));
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
    database.exec(
      `CREATE TRIGGER fail_authorization_start_update
       BEFORE UPDATE OF required_psu_headers_json ON bank_connections
       BEGIN
         SELECT RAISE(ABORT, 'authorization state unavailable');
       END;`
    );
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi.fn().mockResolvedValue({
        url: "https://bank.example/authorize"
      })
    } as unknown as EnableBankingClient;

    await expect(
      new AuthorizationService(config, database, client).reauthorize(
        "connection"
      )
    ).rejects.toThrow("authorization state unavailable");

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM pending_authorizations").get()
    ).toEqual({ count: 0 });
    database.close();
  });

  it("reuses the connection and preserves the account alias", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reauthorization-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const retryAt = new Date(Date.now() + 3_600_000).toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, reauthorization_required,
           retry_after_at, error_code, error_message_safe, online_retry_used
         ) VALUES (
           'connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
           'personal', 'Demo Bank personal', 'REAUTHORIZATION_REQUIRED', ?, 1,
           ?, 'ASPSP_RATE_LIMIT_EXCEEDED', 'Wait for the bank.', 1
         )`
      )
      .run(now, retryAt);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('old-session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("old-provider-session", config.sessionEncryptionKey), now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('recovery-session', 'connection', ?, ?, 'REVOCATION_REQUIRED')`
      )
      .run(
        encryptSecret("recovery-provider-session", config.sessionEncryptionKey),
        now
      );
    const iban = "ES0100000000000000000001";
    const stableHash = ibanIdentificationHash("stable-account");
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           iban_masked, name, account_alias, active, first_seen_at, last_seen_at
         ) VALUES (
           'account', 'connection', 'old-account-id', ?, 'ES************01',
           'Current account', 'Household', 1, ?, ?
         )`
      )
      .run(stableHash, now, now);

    let authorizationState = "";
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi.fn().mockImplementation((input: { state: string }) => {
        authorizationState = input.state;
        return Promise.resolve({ url: "https://bank.example/authorize" });
      }),
      authorizeSession: vi.fn().mockResolvedValue({
        session_id: "new-session",
        accounts: [
          {
            uid: "new-account-id",
            identification_hash: stableHash,
            account_id: { iban },
            name: "Current account",
            currency: "EUR"
          }
        ],
        access: { valid_until: "2026-10-01T00:00:00Z" }
      }),
      deleteSession
    } as unknown as EnableBankingClient;
    const rawWrite = vi.spyOn(RawStore.prototype, "write");
    const service = new AuthorizationService(config, database, client);

    const started = await service.reauthorize("connection");
    expect(
      database
        .prepare(
          `SELECT retry_after_at, error_code, error_message_safe,
                  online_retry_used
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({
      retry_after_at: retryAt,
      error_code: "ASPSP_RATE_LIMIT_EXCEEDED",
      error_message_safe: "Wait for the bank.",
      online_retry_used: 1
    });
    const completed = await service.complete({
      state: authorizationState,
      code: "authorization-code"
    });

    expect(started.connectionId).toBe("connection");
    expect(completed.status).toBe("authorized");
    expect(rawWrite).toHaveBeenCalledWith(
      "session",
      "connection",
      expect.objectContaining({ session_id: "[REDACTED]" })
    );
    expect(
      database
        .prepare(
          `SELECT retry_after_at, error_code, error_message_safe,
                  online_retry_used
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({
      retry_after_at: retryAt,
      error_code: "ASPSP_RATE_LIMIT_EXCEEDED",
      error_message_safe: "Wait for the bank.",
      online_retry_used: 1
    });
    expect(deleteSession).toHaveBeenCalledWith("recovery-provider-session");
    expect(deleteSession).toHaveBeenCalledWith("old-provider-session");
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM provider_sessions
           WHERE status = 'REVOCATION_REQUIRED'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM bank_connections").get()
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT provider_account_id, account_alias, active
           FROM accounts WHERE id = 'account'`
        )
        .get()
    ).toEqual({
      provider_account_id: "new-account-id",
      account_alias: "Household",
      active: 1
    });
    expect(
      database
        .prepare("SELECT status FROM provider_sessions WHERE id = 'old-session'")
        .get()
    ).toBeUndefined();
    database.close();
  });

  it("creates and completes a new connection for the selected bank", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-new-connection-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    let authorizationState = "";
    const listBanks = vi.fn().mockResolvedValue([
      {
        name: "Second Demo Bank",
        country: "ES",
        psu_types: ["personal"],
        auth_methods: [],
        maximum_consent_validity: 7_776_000
      }
    ]);
    const client = {
      listBanks,
      startAuthorization: vi.fn().mockImplementation((input: { state: string }) => {
        authorizationState = input.state;
        return Promise.resolve({ url: "https://bank.example/authorize" });
      }),
      authorizeSession: vi.fn().mockResolvedValue({
        session_id: "new-session",
        accounts: [
          {
            uid: "account-id",
            identification_hash: "account-hash",
            name: "Main account",
            currency: "EUR"
          }
        ]
      })
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);

    const started = await service.connect({
      bankSearch: "Second Demo Bank",
      country: "ES",
      psuType: "personal"
    });

    expect(listBanks).toHaveBeenCalledWith("ES", "personal");
    expect(started.connectionAlias).toBe("Second Demo Bank personal");
    expect(
      database
        .prepare(
          "SELECT bank_name, bank_country, psu_type, status FROM bank_connections"
        )
        .get()
    ).toEqual({
      bank_name: "Second Demo Bank",
      bank_country: "ES",
      psu_type: "personal",
      status: "PENDING_AUTHORIZATION"
    });

    const completed = await service.complete({
      state: authorizationState,
      code: "authorization-code"
    });

    expect(completed.status).toBe("authorized");
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM accounts WHERE active = 1")
        .get()
    ).toEqual({ count: 1 });
    database.close();
  });

  it("keeps a previous session reachable when remote revocation fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reauthorization-recovery-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('old-session', 'connection', ?, ?, 'AUTHORIZED')`
      )
      .run(encryptSecret("old-provider-session", config.sessionEncryptionKey), now);

    let authorizationState = "";
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi.fn().mockImplementation((input: { state: string }) => {
        authorizationState = input.state;
        return Promise.resolve({ url: "https://bank.example/authorize" });
      }),
      authorizeSession: vi.fn().mockResolvedValue({
        session_id: "new-session",
        accounts: []
      }),
      deleteSession: vi.fn().mockRejectedValue(new Error("Provider unavailable."))
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);

    await service.reauthorize("connection");
    const completed = await service.complete({
      state: authorizationState,
      code: "authorization-code"
    });

    expect(completed.status).toBe("authorized");
    expect(
      database
        .prepare(
          `SELECT status FROM provider_sessions
           WHERE id = 'old-session'`
        )
        .get()
    ).toEqual({ status: "REVOCATION_REQUIRED" });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM provider_sessions
           WHERE status = 'AUTHORIZED'`
        )
        .get()
    ).toEqual({ count: 1 });
    database.close();
  });

  it("keeps a valid consent usable until renewal is durable", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-safe-renewal-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();
    const retryAt = new Date(Date.now() + 3_600_000).toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, valid_until, retry_after_at, error_code,
           error_message_safe, online_retry_used
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?, ?, ?,
                   'ASPSP_RATE_LIMIT_EXCEEDED', 'Wait for the bank.', 1)`
      )
      .run(now, validUntil, retryAt);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at,
           valid_until, status
         ) VALUES ('old-session', 'connection', ?, ?, ?, 'AUTHORIZED')`
      )
      .run(
        encryptSecret("old-provider-session", config.sessionEncryptionKey),
        now,
        validUntil
      );

    let authorizationState = "";
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi.fn().mockImplementation((input: { state: string }) => {
        authorizationState = input.state;
        return Promise.resolve({ url: "https://bank.example/authorize" });
      }),
      authorizeSession: vi.fn().mockResolvedValue({
        session_id: "new-session",
        accounts: [],
        access: { valid_until: validUntil }
      }),
      deleteSession
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);
    const cooldown = (): unknown =>
      database
        .prepare(
          `SELECT retry_after_at, error_code, error_message_safe,
                  online_retry_used
           FROM bank_connections WHERE id = 'connection'`
        )
        .get();
    const expectedCooldown = {
      retry_after_at: retryAt,
      error_code: "ASPSP_RATE_LIMIT_EXCEEDED",
      error_message_safe: "Wait for the bank.",
      online_retry_used: 1
    };

    await service.reauthorize("connection");
    expect(cooldown()).toEqual(expectedCooldown);
    expect(
      database
        .prepare(
          `SELECT status, reauthorization_required
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({ status: "AUTHORIZED", reauthorization_required: 0 });

    const denied = await service.complete({
      state: authorizationState,
      error: "access_denied",
      errorDescription: "Denied with code=secret-code&state=secret-state"
    });
    expect(denied.status).toBe("denied");
    expect(denied.message).toContain("code=[REDACTED]");
    expect(denied.message).not.toContain("secret-code");
    expect(denied.message).not.toContain("secret-state");
    expect(cooldown()).toEqual(expectedCooldown);
    expect(
      database
        .prepare(
          `SELECT status, reauthorization_required
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({ status: "AUTHORIZED", reauthorization_required: 0 });

    await service.reauthorize("connection");
    vi.spyOn(RawStore.prototype, "write").mockRejectedValue(new Error("Disk full."));
    const failed = await service.complete({
      state: authorizationState,
      code: "authorization-code"
    });

    expect(failed.status).toBe("failed");
    expect(cooldown()).toEqual(expectedCooldown);
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith("new-session");
    expect(
      database
        .prepare(
          `SELECT status FROM provider_sessions
           WHERE id = 'old-session'`
        )
        .get()
    ).toEqual({ status: "AUTHORIZED" });
    expect(
      database
        .prepare(
          `SELECT status, reauthorization_required
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({ status: "AUTHORIZED", reauthorization_required: 0 });
    database.close();
  });

  it("revokes a newly created remote session when local finalization fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-authorization-compensation-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    let authorizationState = "";
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = {
      listBanks: vi.fn().mockResolvedValue([
        {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        }
      ]),
      startAuthorization: vi.fn().mockImplementation((input: { state: string }) => {
        authorizationState = input.state;
        return Promise.resolve({ url: "https://bank.example/authorize" });
      }),
      authorizeSession: vi.fn().mockResolvedValue({
        session_id: "orphan-session",
        accounts: []
      }),
      deleteSession
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);
    await service.connect({
      bankSearch: "Demo Bank",
      country: "ES",
      psuType: "personal"
    });
    vi.spyOn(RawStore.prototype, "write").mockRejectedValue(new Error("Disk full."));

    const completed = await service.complete({
      state: authorizationState,
      code: "authorization-code"
    });

    expect(completed.status).toBe("failed");
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith("orphan-session");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM provider_sessions").get()
    ).toEqual({ count: 0 });
    database.close();
  });
});
