import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disconnectBankConnection } from "../../src/auth/disconnect-service.js";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { createDatabase } from "../../src/storage/database.js";
import { encryptSecret } from "../../src/utils/crypto.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function createConnection(): Promise<{
  config: ReturnType<typeof testConfig>;
  database: ReturnType<typeof createDatabase>;
}> {
  root = await mkdtemp(join(tmpdir(), "kakebo-disconnect-"));
  const config = testConfig(root);
  const database = createDatabase(config.databasePath);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type,
         alias, status, created_at
       ) VALUES (
         'connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
         'personal', 'Demo Bank personal', 'AUTHORIZED', ?
       )`
    )
    .run(now);
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
         id, bank_connection_id, provider_account_id, name, active,
         first_seen_at, last_seen_at
       ) VALUES ('account', 'connection', 'provider-account', 'Account', 1, ?, ?)`
    )
    .run(now, now);
  return { config, database };
}

describe("bank connection revocation", () => {
  it("revokes the remote session and preserves local history", async () => {
    const { config, database } = await createConnection();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = { deleteSession } as unknown as EnableBankingClient;

    const result = await disconnectBankConnection({
      config,
      database,
      client,
      connectionId: "connection"
    });

    expect(deleteSession).toHaveBeenCalledWith("provider-session");
    expect(result).toEqual({
      remoteRevocationAttempted: true,
      remoteRevoked: true
    });
    expect(
      database
        .prepare(
          "SELECT status, reauthorization_required FROM bank_connections WHERE id = 'connection'"
        )
        .get()
    ).toEqual({ status: "REVOKED", reauthorization_required: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM provider_sessions").get()
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT active FROM accounts WHERE id = 'account'").get()
    ).toEqual({ active: 0 });
    database.close();
  });

  it("keeps the local revocation when the provider cannot confirm it", async () => {
    const { config, database } = await createConnection();
    const client = {
      deleteSession: vi.fn().mockRejectedValue(new Error("Network unavailable"))
    } as unknown as EnableBankingClient;

    const result = await disconnectBankConnection({
      config,
      database,
      client,
      connectionId: "connection"
    });

    expect(result).toEqual({
      remoteRevocationAttempted: true,
      remoteRevoked: false
    });
    expect(
      database
        .prepare("SELECT status FROM bank_connections WHERE id = 'connection'")
        .get()
    ).toEqual({ status: "REVOKED" });
    database.close();
  });
});
