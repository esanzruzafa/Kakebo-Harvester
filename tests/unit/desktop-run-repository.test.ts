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
  it("returns the latest successfully completed run independently of connection sync state", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-last-completed-run-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const repository = new DesktopRunRepository(database);
    const insert = database.prepare(
      `INSERT INTO desktop_runs (
         id, started_at, finished_at, status, date_from, date_to, steps_json
       ) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-31', '[]')`
    );
    insert.run(
      "successful-export",
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:01:00.000Z",
      "SUCCESS"
    );
    insert.run(
      "failed-later-run",
      "2026-08-02T10:00:00.000Z",
      "2026-08-02T10:01:00.000Z",
      "FAILED"
    );
    insert.run(
      "successful-warnings",
      "2026-08-03T10:00:00.000Z",
      "2026-08-03T10:01:00.000Z",
      "SUCCESS_WITH_WARNINGS"
    );

    expect(repository.lastCompletedAt()).toBe("2026-08-03T10:01:00.000Z");
    database.close();
  });

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

  it("sums audit balances with exact currency precision", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-audit-precision-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo Bank', 'KW',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    for (const id of ["one", "two"] as const) {
      database
        .prepare(
          `INSERT INTO accounts (
             id, bank_connection_id, provider_account_id, name, active,
             first_seen_at, last_seen_at
           ) VALUES (?, 'connection', ?, ?, 1, ?, ?)`
        )
        .run(id, id, id, now, now);
    }
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
         ) VALUES (?, ?, 'CLBD', ?, 'KWD', ?, ?)`
      )
      .run("balance-one", "one", "9007199254740993.125", now, runId);
    database
      .prepare(
        `INSERT INTO balances (
           id, account_id, balance_type, amount, currency, extracted_at,
           desktop_run_id
         ) VALUES (?, ?, 'CLBD', ?, 'KWD', ?, ?)`
      )
      .run("balance-two", "two", "0.550", now, runId);
    repository.finish(runId, "SUCCESS");

    expect(repository.list()[0]?.totals).toEqual([
      { amount: "9007199254740993.675", currency: "KWD" }
    ]);
    database.close();
  });

  it("selects the latest reference date when balances share a preferred type", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-audit-reference-date-"));
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
           id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`
      )
      .run(now, now);
    const repository = new DesktopRunRepository(database);
    const runId = repository.begin({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      steps: ["balances"]
    });
    const insert = database.prepare(
      `INSERT INTO balances (
         id, account_id, balance_type, amount, currency, reference_date, extracted_at, desktop_run_id
       ) VALUES (?, 'account', 'CLBD', ?, 'EUR', ?, ?, ?)`
    );
    insert.run("a-older", "100", "2026-01-30", now, runId);
    insert.run("z-newer", "200", "2026-01-31", now, runId);

    repository.finish(runId, "SUCCESS");

    expect(repository.list()[0]?.accounts).toMatchObject([
      { amount: "200", referenceDate: "2026-01-31" }
    ]);
    database.close();
  });

  it("rolls back balance snapshots when a run cannot be finalized", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-audit-rollback-"));
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
           id, bank_connection_id, provider_account_id, name, active,
           first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`
      )
      .run(now, now);
    const repository = new DesktopRunRepository(database);
    const runId = repository.begin({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      steps: ["accounts"]
    });
    database.exec(
      `CREATE TRIGGER reject_desktop_run_finish
       BEFORE UPDATE ON desktop_runs
       BEGIN
         SELECT RAISE(ABORT, 'audit storage unavailable');
       END`
    );

    expect(() => repository.finish(runId, "SUCCESS")).toThrow(
      "audit storage unavailable"
    );
    expect(
      database
        .prepare("SELECT COUNT(*) AS total FROM desktop_run_accounts")
        .get()
    ).toEqual({ total: 0 });
    expect(
      database
        .prepare("SELECT status, finished_at FROM desktop_runs WHERE id = ?")
        .get(runId)
    ).toEqual({ status: "RUNNING", finished_at: null });
    database.close();
  });

  it("marks orphaned running audit entries as interrupted", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-audit-interrupted-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const repository = new DesktopRunRepository(database);
    const runId = repository.begin({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      steps: ["transactions"]
    });

    expect(
      repository.recoverInterruptedRuns(new Date("2026-08-31T09:00:00.000Z"))
    ).toBe(1);
    expect(
      database
        .prepare(
          "SELECT status, error_code, error_message_safe FROM desktop_runs WHERE id = ?"
        )
        .get(runId)
    ).toEqual({
      status: "FAILED",
      error_code: "INTERRUPTED",
      error_message_safe:
        "The previous process ended before this synchronization was finalized."
    });
    database.close();
  });

  it("does not recover running entries while another synchronization lease is active", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-audit-active-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const repository = new DesktopRunRepository(database);
    repository.begin({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      steps: ["transactions"]
    });
    database
      .prepare(
        `INSERT INTO application_locks (name, owner, acquired_at)
         VALUES ('synchronization', 'other-process', ?)`
      )
      .run("2026-08-31T08:59:00.000Z");

    expect(
      repository.recoverInterruptedRuns(new Date("2026-08-31T08:00:00.000Z"))
    ).toBe(0);
    expect(repository.list()[0]?.status).toBe("RUNNING");
    database.close();
  });
});
