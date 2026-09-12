import { lstat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SqliteDatabase } from "./database.js";
import { AccountRepository, type AccountPurgeCounts } from "./repositories/account-repository.js";
import { createId } from "../utils/crypto.js";

export type AccountRemovalMode = "keep-history" | "delete-history";

export interface AccountRemovalResult {
  status: "hidden" | "deleted";
  counts: AccountPurgeCounts;
  rawCleanup: {
    removed: number;
    warnings: RawCleanupWarning[];
  };
  audit: AccountRemovalAuditEvent;
}

export type RawCleanupWarning =
  | "ambiguous"
  | "cleanup-failed"
  | "missing"
  | "outside-root"
  | "shared"
  | "symbolic-link";

export interface AccountRemovalAuditEvent {
  action: "local-account-removal";
  outcome: "hidden" | "deleted";
  occurredAt: string;
}

export interface RawFileOperations {
  lstat: (path: string) => Promise<{
    isSymbolicLink: () => boolean;
    isFile: () => boolean;
  }>;
  unlink: (path: string) => Promise<void>;
}

export interface RemoveLocalAccountInput {
  database: SqliteDatabase;
  environment: string;
  accountId: string;
  mode: AccountRemovalMode;
  rawDataDirectory?: string;
}

const emptyCounts: AccountPurgeCounts = {
  accounts: 0,
  balances: 0,
  transactions: 0,
  transactionsRaw: 0,
  synchronizationRuns: 0
};

export interface PendingLocalAccountRemoval {
  finalize: () => Promise<AccountRemovalResult>;
  rollback: () => void;
}

interface StoredAuditEvent extends AccountRemovalAuditEvent {
  id: string;
}

interface TableSnapshot {
  table: string;
  rows: Array<Record<string, unknown>>;
}

export function removeLocalAccount(
  input: RemoveLocalAccountInput
): Promise<AccountRemovalResult> {
  return beginLocalAccountRemoval(input).then(async (pending) =>
    await pending.finalize()
  );
}

export function beginLocalAccountRemoval(
  input: RemoveLocalAccountInput
): Promise<PendingLocalAccountRemoval> {
  return Promise.resolve().then(() => {
    const accounts = new AccountRepository(input.database);
    if (input.mode === "keep-history") {
      const { previous, audit } = input.database.transaction(() => {
        const previous = input.database
          .prepare(
            `SELECT hidden, sync_enabled, export_enabled FROM accounts
             WHERE id = ?`
          )
          .get(input.accountId) as
          | { hidden: number; sync_enabled: number; export_enabled: number }
          | undefined;
        if (!previous || !accounts.hideLocalAccount(input.accountId, input.environment)) {
          throw new Error("The account does not exist in the active environment.");
        }
        return { previous, audit: persistAuditEvent(input.database, "hidden") };
      })();
      return {
        rollback: () => {
          input.database
            .prepare(
              `UPDATE accounts SET hidden = ?, sync_enabled = ?, export_enabled = ?
               WHERE id = ?`
            )
            .run(
              previous.hidden,
              previous.sync_enabled,
              previous.export_enabled,
              input.accountId
            );
          removeAuditEvent(input.database, audit.id);
        },
        finalize: () => Promise.resolve({
          status: "hidden",
          counts: emptyCounts,
          rawCleanup: { removed: 0, warnings: [] },
          audit: publicAuditEvent(audit)
        })
      };
    }
    const rawPaths = input.rawDataDirectory
      ? accountRawPaths(input.database, input.accountId)
      : [];
    const snapshots = captureAccountRows(input.database, input.accountId);
    const { counts, audit } = input.database.transaction(() => {
      const counts = accounts.purgeLocalAccount(input.accountId, input.environment);
      if (!counts) {
        throw new Error("The account does not exist in the active environment.");
      }
      return { counts, audit: persistAuditEvent(input.database, "deleted") };
    })();
    return {
      rollback: () => {
        restoreAccountRows(input.database, snapshots);
        removeAuditEvent(input.database, audit.id);
      },
      finalize: async () => ({
        status: "deleted",
        counts,
        rawCleanup: input.rawDataDirectory
          ? await cleanupRawFiles(rawPaths, input.rawDataDirectory, (path) =>
              hasOtherRawOwner(input.database, input.accountId, path)
            )
          : { removed: 0, warnings: [] },
        audit: publicAuditEvent(audit)
      })
    };
  });
}

function captureAccountRows(database: SqliteDatabase, accountId: string): TableSnapshot[] {
  const tables = [
    ["accounts", "id"],
    ["balances", "account_id"],
    ["transactions_raw", "account_id"],
    ["transactions", "account_id"],
    ["sync_runs", "account_id"],
    ["desktop_run_accounts", "account_id"],
    ["account_identification_hashes", "account_id"]
  ] as const;
  return tables.map(([table, column]) => ({
    table,
    rows: database
      .prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
      .all(accountId) as Array<Record<string, unknown>>
  }));
}

function restoreAccountRows(database: SqliteDatabase, snapshots: TableSnapshot[]): void {
  const restore = database.transaction(() => {
    for (const snapshot of snapshots) {
      for (const row of snapshot.rows) {
        const columns = Object.keys(row);
        const placeholders = columns.map(() => "?").join(", ");
        database
          .prepare(
            `INSERT INTO ${snapshot.table} (${columns.join(", ")}) VALUES (${placeholders})`
          )
          .run(...columns.map((column) => row[column]));
      }
    }
  });
  restore();
}

function persistAuditEvent(
  database: SqliteDatabase,
  outcome: AccountRemovalAuditEvent["outcome"]
): StoredAuditEvent {
  const audit: StoredAuditEvent = {
    id: createId(),
    action: "local-account-removal",
    outcome,
    occurredAt: new Date().toISOString()
  };
  database
    .prepare(
      `INSERT INTO local_account_removal_audit_events (id, action, outcome, occurred_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(audit.id, audit.action, audit.outcome, audit.occurredAt);
  return audit;
}

function removeAuditEvent(database: SqliteDatabase, id: string): void {
  database
    .prepare("DELETE FROM local_account_removal_audit_events WHERE id = ?")
    .run(id);
}

function publicAuditEvent(audit: StoredAuditEvent): AccountRemovalAuditEvent {
  return {
    action: audit.action,
    outcome: audit.outcome,
    occurredAt: audit.occurredAt
  };
}

function accountRawPaths(database: SqliteDatabase, accountId: string): string[] {
  return database
    .prepare(
      `SELECT DISTINCT path FROM (
         SELECT raw_response_path AS path FROM accounts WHERE id = ?
         UNION ALL SELECT raw_response_path FROM balances WHERE account_id = ?
         UNION ALL SELECT raw_response_path FROM transactions_raw WHERE account_id = ?
         UNION ALL SELECT source_raw_file FROM transactions WHERE account_id = ?
       ) WHERE path IS NOT NULL AND trim(path) <> ''`
    )
    .all(accountId, accountId, accountId, accountId)
    .map((row) => (row as { path: string }).path);
}

function hasOtherRawOwner(database: SqliteDatabase, accountId: string, path: string): boolean {
  const candidate = canonicalRawPath(path);
  const rows = database
    .prepare(
      `SELECT path FROM (
         SELECT id AS account_id, raw_response_path AS path FROM accounts
         UNION ALL SELECT account_id, raw_response_path FROM balances
         UNION ALL SELECT account_id, raw_response_path FROM transactions_raw
         UNION ALL SELECT account_id, source_raw_file FROM transactions
       ) WHERE account_id <> ? AND path IS NOT NULL`
    )
    .all(accountId) as Array<{ path: string }>;
  return rows.some((row) => canonicalRawPath(row.path) === candidate);
}

function canonicalRawPath(path: string): string {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

const defaultRawFileOperations: RawFileOperations = { lstat, unlink };

export async function cleanupRawFiles(
  paths: string[],
  rawDataDirectory: string,
  hasOtherOwner: (path: string) => boolean,
  operations: RawFileOperations = defaultRawFileOperations
): Promise<AccountRemovalResult["rawCleanup"]> {
  const rawRoot = canonicalRawPath(rawDataDirectory);
  try {
    if ((await operations.lstat(rawRoot)).isSymbolicLink()) {
      return { removed: 0, warnings: ["symbolic-link"] };
    }
  } catch (error) {
    return {
      removed: 0,
      warnings: [
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "cleanup-failed"
      ]
    };
  }
  const warnings: RawCleanupWarning[] = [];
  let removed = 0;
  for (const path of paths) {
    try {
      if (hasOtherOwner(path)) {
        warnings.push("shared");
        continue;
      }
      const candidate = canonicalRawPath(path);
      if (dirname(candidate) !== rawRoot) {
        warnings.push("outside-root");
        continue;
      }
      const details = await operations.lstat(candidate);
      if (details.isSymbolicLink()) {
        warnings.push("symbolic-link");
      } else if (!details.isFile()) {
        warnings.push("ambiguous");
      } else {
        await operations.unlink(candidate);
        removed += 1;
      }
    } catch (error) {
      warnings.push(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "cleanup-failed"
      );
    }
  }
  return { removed, warnings: [...new Set(warnings)] };
}
