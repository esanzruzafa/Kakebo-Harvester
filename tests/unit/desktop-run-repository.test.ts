import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/storage/database.js";
import { DesktopRunRepository } from "../../src/storage/repositories/desktop-run-repository.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("desktop run repository", () => {
  it("persists one selected balance snapshot per account and clears only audit data", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-audit-"));
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
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name, account_alias,
           active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider', 'Account', 'Household',
                   1, ?, ?)`
      )
      .run(now, now);

    const repository = new DesktopRunRepository(database);
    const runId = repository.begin({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      steps: ["balances"]
    });
    database
      .prepare(
        `INSERT INTO balances (
           id, account_id, balance_type, amount, currency, extracted_at,
           desktop_run_id
         ) VALUES ('balance', 'account', 'CLBD', '123.45', 'EUR', ?, ?)`
      )
      .run(now, runId);
    repository.finish(runId, "SUCCESS");

    const runs = repository.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.accounts[0]).toMatchObject({
      account: "Household",
      amount: "123.45",
      currency: "EUR"
    });
    expect(runs[0]?.totals).toEqual([{ amount: "123.45", currency: "EUR" }]);
    expect(
      repository.countBetween(new Date(2020, 0, 1), new Date(2030, 0, 1))
    ).toBe(1);
    expect(repository.clear()).toBe(1);
    expect(repository.list()).toEqual([]);
    expect(
      database.prepare("SELECT COUNT(*) AS total FROM balances").get()
    ).toEqual({ total: 1 });
    database.close();
  });
});
