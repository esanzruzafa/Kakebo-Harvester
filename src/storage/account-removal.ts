import { lstat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

const rollbackTables = [
  ["accounts", "id"],
  ["balances", "account_id"],
  ["transactions_raw", "account_id"],
  ["transactions", "account_id"],
  ["sync_runs", "account_id"],
  ["desktop_run_accounts", "account_id"],
  ["account_identification_hashes", "account_id"]
] as const;

const rollbackTableName = (table: string): string => `account_removal_rollback_${table}`;

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
    const { counts, audit } = input.database.transaction(() => {
      createAccountRollbackStore(input.database, input.accountId);
      const counts = accounts.purgeLocalAccount(input.accountId, input.environment);
      if (!counts) {
        throw new Error("The account does not exist in the active environment.");
      }
      return { counts, audit: persistAuditEvent(input.database, "deleted") };
    })();
    return {
      rollback: () => {
        input.database.transaction(() => {
          restoreAccountRows(input.database);
          removeAuditEvent(input.database, audit.id);
          dropAccountRollbackStore(input.database);
        })();
      },
      finalize: async () => {
        try {
          let rawCleanup: AccountRemovalResult["rawCleanup"] = { removed: 0, warnings: [] };
          if (input.rawDataDirectory) {
            try {
              const rawOwners = otherRawOwnerPaths(input.database);
              rawCleanup = await cleanupRawFiles(rawPaths, input.rawDataDirectory, (path) =>
                rawOwners.has(canonicalRawPath(path))
              );
            } catch {
              rawCleanup = { removed: 0, warnings: ["cleanup-failed"] };
            }
          }
          return {
            status: "deleted" as const,
            counts,
            rawCleanup,
            audit: publicAuditEvent(audit)
          };
        } finally {
          dropAccountRollbackStore(input.database);
        }
      }
    };
  });
}

function createAccountRollbackStore(database: SqliteDatabase, accountId: string): void {
  for (const [table, column] of rollbackTables) {
    const rollbackTable = rollbackTableName(table);
    database.exec(`DROP TABLE IF EXISTS temp.${rollbackTable}`);
    database.prepare(
      `CREATE TEMP TABLE ${rollbackTable} AS SELECT * FROM ${table} WHERE ${column} = ?`
    ).run(accountId);
  }
  const rollbackTable = rollbackTableName("card_import_source_rows");
  database.exec(`DROP TABLE IF EXISTS temp.${rollbackTable}`);
  database.prepare(
    `CREATE TEMP TABLE ${rollbackTable} AS
     SELECT source.* FROM card_import_source_rows source
     JOIN accounts a ON a.provider_account_id = source.profile_id
     JOIN bank_connections c ON c.id = a.bank_connection_id
     WHERE a.id = ? AND c.provider = 'manual-card'`
  ).run(accountId);
}

function restoreAccountRows(database: SqliteDatabase): void {
  for (const [table] of rollbackTables) {
    database.prepare(`INSERT INTO ${table} SELECT * FROM ${rollbackTableName(table)}`).run();
  }
  database.prepare(
    `INSERT INTO card_import_source_rows SELECT * FROM ${rollbackTableName("card_import_source_rows")}`
  ).run();
}

function dropAccountRollbackStore(database: SqliteDatabase): void {
  for (const [table] of [...rollbackTables, ["card_import_source_rows", "profile_id"]] as const) {
    database.exec(`DROP TABLE IF EXISTS temp.${rollbackTableName(table)}`);
  }
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
         UNION ALL
         SELECT t.source_raw_file FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN bank_connections c ON c.id = a.bank_connection_id
         WHERE t.account_id = ? AND c.provider <> 'manual-card'
       ) WHERE path IS NOT NULL AND trim(path) <> ''`
    )
    .all(accountId, accountId, accountId, accountId)
    .map((row) => (row as { path: string }).path);
}

function otherRawOwnerPaths(database: SqliteDatabase): Set<string> {
  const rows = database
    .prepare(
      `SELECT path FROM (
         SELECT id AS account_id, raw_response_path AS path FROM accounts
         UNION ALL SELECT account_id, raw_response_path FROM balances
         UNION ALL SELECT account_id, raw_response_path FROM transactions_raw
         UNION ALL
         SELECT t.account_id, t.source_raw_file FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN bank_connections c ON c.id = a.bank_connection_id
         WHERE c.provider <> 'manual-card'
         UNION ALL SELECT NULL AS account_id, raw_response_path FROM provider_sessions
       ) WHERE path IS NOT NULL AND trim(path) <> ''`
    )
    .all() as Array<{ path: string }>;
  return new Set(rows.map((row) => canonicalRawPath(row.path)));
}

function canonicalRawPath(path: string): string {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function rawFileParents(candidate: string, rawRoot: string): string[] | null {
  const relativePath = relative(rawRoot, candidate);
  if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    return null;
  }
  const parts = relativePath.split(sep);
  if (parts.length === 1) return [];
  const [date, account] = parts;
  if (
    parts.length === 3 &&
    date !== undefined &&
    account !== undefined &&
    /^\d{4}-\d{2}-\d{2}$/u.test(date) &&
    /^[a-zA-Z0-9_-]{1,80}$/u.test(account)
  ) {
    return [join(rawRoot, date), join(rawRoot, date, account)];
  }
  return null;
}

const defaultRawFileOperations: RawFileOperations = { lstat, unlink };

export async function cleanupRawFiles(
  paths: string[],
  rawDataDirectory: string,
  hasOtherOwner: (path: string) => boolean,
  operations: RawFileOperations = defaultRawFileOperations
): Promise<AccountRemovalResult["rawCleanup"]> {
  if (paths.length === 0) return { removed: 0, warnings: [] };

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
      const parents = rawFileParents(candidate, rawRoot);
      if (parents === null) {
        warnings.push("outside-root");
        continue;
      }
      if ((await Promise.all(parents.map(async (parent) => await operations.lstat(parent)))).some(
        (details) => details.isSymbolicLink()
      )) {
        warnings.push("symbolic-link");
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
