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
          `SELECT error_code, retry_after_at
           FROM bank_connections WHERE id = 'connection'`
        )
        .get()
    ).toEqual({
      error_code: "ASPSP_RATE_LIMIT_EXCEEDED",
      retry_after_at: "2026-07-28T16:00:00.000Z"
    });

    await expect(service.syncAccounts()).rejects.toBeInstanceOf(RateLimitError);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getAccount).toHaveBeenCalledTimes(1);

    await expect(
      service.syncAccounts({
        psuHeaders: {
          userAgent: "Kakebo-Harvester/0.1.0 Electron/43",
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
          userAgent: "Kakebo-Harvester/0.1.0 Electron/43",
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
          userAgent: "Kakebo-Harvester/0.1.0 Electron/43",
          acceptLanguage: "es"
        }
      })
    ).rejects.toBeInstanceOf(PsuHeadersUnavailableError);
    expect(getSession).not.toHaveBeenCalled();
    database.close();
  });
});
