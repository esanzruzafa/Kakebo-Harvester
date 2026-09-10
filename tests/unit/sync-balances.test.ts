import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { ReauthorizationRequiredError } from "../../src/errors.js";
import { createDatabase } from "../../src/storage/database.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("balance synchronization", () => {
  it("does not persist a partial snapshot when reauthorization interrupts the step", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-balances-"));
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
         ) VALUES ('session', 'connection', 'ciphertext', ?, 'AUTHORIZED')`
      )
      .run(now);
    const insertAccount = database.prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, name,
         active, first_seen_at, last_seen_at
       ) VALUES (?, 'connection', ?, ?, 1, ?, ?)`
    );
    insertAccount.run("account-a", "provider-a", "Account A", now, now);
    insertAccount.run("account-b", "provider-b", "Account B", now, now);
    const client = {
      getBalances: vi
        .fn()
        .mockResolvedValueOnce({
          balances: [
            {
              balance_amount: { amount: "100.00", currency: "EUR" },
              balance_type: "CLBD"
            }
          ]
        })
        .mockRejectedValueOnce(
          new ReauthorizationRequiredError("Session expired.")
        )
    } as unknown as EnableBankingClient;

    await expect(
      new SyncService(config, database, client).syncBalances()
    ).rejects.toThrow(ReauthorizationRequiredError);
    expect(database.prepare("SELECT COUNT(*) AS count FROM balances").get()).toEqual({
      count: 0
    });
    database.close();
  });

  it("rejects accumulated balance responses before persisting snapshots", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-sync-balance-buffer-"));
    const config = testConfig(root);
    config.maxBufferedBalanceBytes = 1;
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'ES',
                   'personal', 'Demo Bank personal', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO provider_sessions (
           id, bank_connection_id, provider_session_id_ciphertext, created_at, status
         ) VALUES ('session', 'connection', 'ciphertext', ?, 'AUTHORIZED')`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name,
           active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`
      )
      .run(now, now);
    const client = {
      getBalances: vi.fn().mockResolvedValue({
        balances: [{ balance_amount: { amount: "100.00", currency: "EUR" } }]
      })
    } as unknown as EnableBankingClient;

    await expect(new SyncService(config, database, client).syncBalances()).rejects.toThrow(
      "MAX_BUFFERED_BALANCE_BYTES"
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM balances").get()).toEqual({
      count: 0
    });
    database.close();
  });
});
