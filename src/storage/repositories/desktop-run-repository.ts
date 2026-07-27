import type { SqliteDatabase } from "../database.js";
import { createId } from "../../utils/crypto.js";
import type { SyncStep } from "../../sync/sync-runner.js";

export interface AuditAccountView {
  id: string;
  bank: string;
  account: string;
  amount: string | null;
  currency: string | null;
  balanceType: string | null;
  referenceDate: string | null;
}

export interface AuditBalanceTotal {
  amount: string;
  currency: string | null;
}

export interface AuditRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  dateFrom: string;
  dateTo: string;
  steps: SyncStep[];
  error: string | null;
  accounts: AuditAccountView[];
  totals: AuditBalanceTotal[];
}

interface AuditRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  date_from: string;
  date_to: string;
  steps_json: string;
  error_message_safe: string | null;
}

interface AuditAccountRow {
  run_id: string;
  account_id: string;
  bank_name: string;
  account_name: string;
  amount: string | null;
  currency: string | null;
  balance_type: string | null;
  balance_reference_date: string | null;
}

function parseSteps(value: string): SyncStep[] {
  const known = new Set<SyncStep>([
    "accounts",
    "balances",
    "transactions",
    "export"
  ]);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (step): step is SyncStep =>
            typeof step === "string" && known.has(step as SyncStep)
        )
      : [];
  } catch {
    return [];
  }
}

function balanceTotals(accounts: AuditAccountView[]): AuditBalanceTotal[] {
  const totals = new Map<string, number>();
  for (const account of accounts) {
    if (account.amount === null) continue;
    const amount = Number(account.amount);
    if (!Number.isFinite(amount)) continue;
    const currency = account.currency ?? "";
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({
      amount: amount.toFixed(2),
      currency: currency || null
    }));
}

export class DesktopRunRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public begin(input: {
    dateFrom: string;
    dateTo: string;
    steps: SyncStep[];
  }): string {
    const id = createId();
    this.database
      .prepare(
        `INSERT INTO desktop_runs (
           id, started_at, status, date_from, date_to, steps_json
         ) VALUES (?, ?, 'RUNNING', ?, ?, ?)`
      )
      .run(
        id,
        new Date().toISOString(),
        input.dateFrom,
        input.dateTo,
        JSON.stringify(input.steps)
      );
    return id;
  }

  public finish(id: string, status: "SUCCESS" | "FAILED", error?: string): void {
    this.captureAccountBalances(id);
    this.database
      .prepare(
        `UPDATE desktop_runs SET
           finished_at = ?, status = ?, error_message_safe = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), status, error ?? null, id);
  }

  private captureAccountBalances(runId: string): void {
    const insert = this.database.prepare(
      `INSERT OR REPLACE INTO desktop_run_accounts (
         run_id, account_id, bank_name, account_name, amount, currency,
         balance_type, balance_reference_date, balance_extracted_at
       )
       SELECT
         ?, a.id, c.bank_name,
         COALESCE(NULLIF(a.account_alias, ''), a.display_name, a.name, 'Account'),
         b.amount, b.currency, b.balance_type, b.reference_date, b.extracted_at
       FROM accounts a
       JOIN bank_connections c ON c.id = a.bank_connection_id
       LEFT JOIN balances b ON b.id = (
         SELECT candidate.id
         FROM balances candidate
         WHERE candidate.account_id = a.id
         ORDER BY
           CASE WHEN candidate.desktop_run_id = ? THEN 0 ELSE 1 END,
           candidate.extracted_at DESC,
           CASE candidate.balance_type
             WHEN 'CLBD' THEN 0
             WHEN 'ITAV' THEN 1
             WHEN 'closingBooked' THEN 2
             WHEN 'interimAvailable' THEN 3
             ELSE 9
           END,
           candidate.id
         LIMIT 1
       )
       WHERE a.active = 1
       ORDER BY
         c.bank_name,
         COALESCE(NULLIF(a.account_alias, ''), a.display_name, a.name, 'Account')`
    );
    insert.run(runId, runId);
  }

  public list(limit?: number): AuditRunView[] {
    const runs = this.database
      .prepare(
        `SELECT id, started_at, finished_at, status, date_from, date_to,
                steps_json, error_message_safe
         FROM desktop_runs
         ORDER BY started_at DESC
         ${limit === undefined ? "" : "LIMIT ?"}`
      )
      .all(...(limit === undefined ? [] : [limit])) as AuditRunRow[];
    if (runs.length === 0) return [];
    const placeholders = runs.map(() => "?").join(", ");
    const accounts = this.database
      .prepare(
        `SELECT run_id, account_id, bank_name, account_name, amount, currency,
                balance_type, balance_reference_date
         FROM desktop_run_accounts
         WHERE run_id IN (${placeholders})
         ORDER BY bank_name, account_name`
      )
      .all(...runs.map((run) => run.id)) as AuditAccountRow[];
    const accountsByRun = new Map<string, AuditAccountView[]>();
    for (const account of accounts) {
      const list = accountsByRun.get(account.run_id) ?? [];
      list.push({
        id: account.account_id,
        bank: account.bank_name,
        account: account.account_name,
        amount: account.amount,
        currency: account.currency,
        balanceType: account.balance_type,
        referenceDate: account.balance_reference_date
      });
      accountsByRun.set(account.run_id, list);
    }
    return runs.map((run) => {
      const runAccounts = accountsByRun.get(run.id) ?? [];
      return {
        id: run.id,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        status: run.status,
        dateFrom: run.date_from,
        dateTo: run.date_to,
        steps: parseSteps(run.steps_json),
        error: run.error_message_safe,
        accounts: runAccounts,
        totals: balanceTotals(runAccounts)
      };
    });
  }

  public countBetween(dateFrom: Date, dateTo: Date): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total
         FROM desktop_runs
         WHERE started_at >= ? AND started_at < ?`
      )
      .get(dateFrom.toISOString(), dateTo.toISOString()) as { total: number };
    return row.total;
  }

  public clear(): number {
    return this.database.transaction(() => {
      this.database.prepare("DELETE FROM desktop_run_accounts").run();
      return this.database.prepare("DELETE FROM desktop_runs").run().changes;
    })();
  }
}
