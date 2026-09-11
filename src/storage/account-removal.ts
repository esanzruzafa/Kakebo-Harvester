import { lstat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SqliteDatabase } from "./database.js";
import { AccountRepository, type AccountPurgeCounts } from "./repositories/account-repository.js";

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

export function removeLocalAccount(
  input: RemoveLocalAccountInput
): Promise<AccountRemovalResult> {
  return Promise.resolve().then(async () => {
    const accounts = new AccountRepository(input.database);
    if (input.mode === "keep-history") {
      if (!accounts.hideLocalAccount(input.accountId, input.environment)) {
        throw new Error("The account does not exist in the active environment.");
      }
      return {
        status: "hidden",
        counts: emptyCounts,
        rawCleanup: { removed: 0, warnings: [] },
        audit: createAuditEvent("hidden")
      };
    }
    const rawPaths = input.rawDataDirectory
      ? accountRawPaths(input.database, input.accountId)
      : [];
    const counts = accounts.purgeLocalAccount(input.accountId, input.environment);
    if (!counts) {
      throw new Error("The account does not exist in the active environment.");
    }
    return {
      status: "deleted",
      counts,
      rawCleanup: input.rawDataDirectory
        ? await cleanupRawFiles(rawPaths, input.rawDataDirectory, (path) =>
            hasOtherRawOwner(input.database, input.accountId, path)
          )
        : { removed: 0, warnings: [] },
      audit: createAuditEvent("deleted")
    };
  });
}

function createAuditEvent(outcome: AccountRemovalAuditEvent["outcome"]): AccountRemovalAuditEvent {
  return { action: "local-account-removal", outcome, occurredAt: new Date().toISOString() };
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
  const warnings: RawCleanupWarning[] = [];
  let removed = 0;
  for (const path of paths) {
    if (hasOtherOwner(path)) {
      warnings.push("shared");
      continue;
    }
    const candidate = canonicalRawPath(path);
    if (dirname(candidate) !== rawRoot) {
      warnings.push("outside-root");
      continue;
    }
    try {
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
