import type { SqliteDatabase } from "../database.js";
import { createId } from "../../utils/crypto.js";
import type { SyncStep } from "../../sync/sync-runner.js";
import { currencyFractionDigits } from "../../utils/currency.js";

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
  errorCode: string | null;
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
  error_code: string | null;
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
  const totals = new Map<string, { units: bigint; scale: number }>();
  for (const account of accounts) {
    if (account.amount === null) continue;
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(account.amount.trim());
    if (!match) continue;
    const fraction = match[3] ?? "";
    const sign = match[1] === "-" ? -1n : 1n;
    const units = sign * BigInt(`${match[2]}${fraction}`);
    const currency = account.currency ?? "";
    const current = totals.get(currency);
    if (!current) {
      totals.set(currency, { units, scale: fraction.length });
      continue;
    }
    const scale = Math.max(current.scale, fraction.length);
    totals.set(currency, {
      units:
        current.units * 10n ** BigInt(scale - current.scale) +
        units * 10n ** BigInt(scale - fraction.length),
      scale
    });
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => {
      const fractionDigits = currencyFractionDigits(currency);
      let units = total.units;
      if (total.scale > fractionDigits) {
        const divisor = 10n ** BigInt(total.scale - fractionDigits);
        const absolute = units < 0n ? -units : units;
        const rounded = (absolute + divisor / 2n) / divisor;
        units = units < 0n ? -rounded : rounded;
      } else if (total.scale < fractionDigits) {
        units *= 10n ** BigInt(fractionDigits - total.scale);
      }
      const negative = units < 0n;
      const absolute = (negative ? -units : units)
        .toString()
        .padStart(fractionDigits + 1, "0");
      const amount =
        fractionDigits === 0
          ? absolute
          : `${absolute.slice(0, -fractionDigits)}.${absolute.slice(-fractionDigits)}`;
      return {
        amount: negative && units !== 0n ? `-${amount}` : amount,
        currency: currency || null
      };
    });
}

export class DesktopRunRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public recoverInterruptedRuns(staleLeaseBefore: Date): number {
    const finishedAt = new Date().toISOString();
    return this.database
      .prepare(
        `UPDATE desktop_runs
         SET finished_at = ?, status = 'FAILED', error_code = 'INTERRUPTED',
             error_message_safe = ?
         WHERE status = 'RUNNING'
           AND NOT EXISTS (
             SELECT 1
             FROM application_locks
             WHERE name = 'synchronization'
               AND acquired_at >= ?
           )`
      )
      .run(
        finishedAt,
        "The previous process ended before this synchronization was finalized.",
        staleLeaseBefore.toISOString()
      ).changes;
  }

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

  public finish(
    id: string,
    status: "SUCCESS" | "SUCCESS_WITH_WARNINGS" | "FAILED",
    error?: string,
    errorCode?: string
  ): void {
    this.database.transaction(() => {
      this.captureAccountBalances(id);
      const result = this.database
        .prepare(
          `UPDATE desktop_runs SET
             finished_at = ?, status = ?, error_message_safe = ?, error_code = ?
           WHERE id = ?`
        )
        .run(
          new Date().toISOString(),
          status,
          error ?? null,
          errorCode ?? null,
          id
        );
      if (result.changes !== 1) {
        throw new Error(`Unknown desktop run: ${id}`);
      }
    })();
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
                steps_json, error_code, error_message_safe
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
        errorCode: run.error_code,
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
