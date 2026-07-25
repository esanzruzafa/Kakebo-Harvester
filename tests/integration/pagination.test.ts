import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingClient } from "../../src/enable-banking/client.js";
import { transactionsResponseSchema } from "../../src/enable-banking/schemas.js";
import { createDatabase } from "../../src/storage/database.js";
import { SyncService } from "../../src/sync/sync-service.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("paginated transaction synchronization", () => {
  it("reads all pages and remains idempotent on the next run", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-pagination-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Banco Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, identification_hash,
           name, active, first_seen_at, last_seen_at
         ) VALUES (
           'account', 'connection', 'provider-account', 'stable-account',
           'Cuenta Demo', 1, ?, ?
         )`
      )
      .run(now, now);

    const firstFixture = transactionsResponseSchema.parse(
      JSON.parse(
        await readFile(
          resolve("tests/fixtures/transactions-page-1.json"),
          "utf8"
        )
      )
    );
    const secondFixture = transactionsResponseSchema.parse(
      JSON.parse(
        await readFile(
          resolve("tests/fixtures/transactions-page-2.json"),
          "utf8"
        )
      )
    );
    const getTransactions = vi.fn(
      (
        _accountId: string,
        query: { continuationKey?: string }
      ) => Promise.resolve(query.continuationKey ? secondFixture : firstFixture)
    );
    const fakeClient = { getTransactions } as unknown as EnableBankingClient;
    const service = new SyncService(config, database, fakeClient);

    const first = await service.syncTransactions("2026-07-01", "2026-07-24");
    const second = await service.syncTransactions("2026-07-01", "2026-07-24");

    expect(first).toMatchObject({ pages: 2, received: 2, inserted: 2 });
    expect(second).toMatchObject({ pages: 2, received: 2, duplicates: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM transactions").get()
    ).toEqual({ count: 2 });
    expect(getTransactions).toHaveBeenCalledTimes(4);
    expect(getTransactions.mock.calls[1]?.[1]).toMatchObject({
      continuationKey: "page-2"
    });
    database.close();
  });
});
