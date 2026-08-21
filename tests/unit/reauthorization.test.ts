import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../../src/auth/authorization-service.js";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { createDatabase } from "../../src/storage/database.js";
import { RawStore } from "../../src/storage/raw-store.js";
import { encryptSecret } from "../../src/utils/crypto.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("bank reauthorization", () => {
  it("reuses the connection and preserves the account alias", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-reauthorization-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at, reauthorization_required
         ) VALUES (
           'connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
           'personal', 'Demo Bank personal', 'REAUTHORIZATION_REQUIRED', ?, 1
         )`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('old-session', 'connection', 'ciphertext', ?, 'AUTHORIZED')`
      )
      .run(now);
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
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           name, account_alias, active, first_seen_at, last_seen_at
         ) VALUES (
           'account', 'connection', 'old-account-id', 'stable-hash',
           'Current account', 'Household', 1, ?, ?
         )`
      )
      .run(now, now);

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
            identification_hash: "stable-hash",
            name: "Current account",
            currency: "EUR"
          }
        ],
        access: { valid_until: "2026-10-01T00:00:00Z" }
      }),
      deleteSession
    } as unknown as EnableBankingClient;
    const service = new AuthorizationService(config, database, client);

    const started = await service.reauthorize("connection");
    const completed = await service.complete({
      state: authorizationState,
      code: "authorization-code"
    });

    expect(started.connectionId).toBe("connection");
    expect(completed.status).toBe("authorized");
    expect(deleteSession).toHaveBeenCalledWith("recovery-provider-session");
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
        .prepare(
          `SELECT status FROM provider_sessions
           WHERE id = 'old-session'`
        )
        .get()
    ).toEqual({ status: "SUPERSEDED" });
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
