import { rm } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { clearGeneratedExportFiles } from "../export/csv-exporter.js";
import type { SqliteDatabase } from "./database.js";

export interface LocalDataResetResult {
  exportFiles: number;
  transactions: number;
  balances: number;
  synchronizationRuns: number;
}

/**
 * Removes locally collected financial history while preserving bank access and
 * user-maintained configuration.
 */
export async function resetLocalData(
  config: AppConfig,
  database: SqliteDatabase
): Promise<LocalDataResetResult> {
  const exportFiles = await clearGeneratedExportFiles(config);
  const result = database.transaction(() => {
    const transactions = database.prepare("DELETE FROM transactions").run().changes;
    database.prepare("DELETE FROM transactions_raw").run();
    const balances = database.prepare("DELETE FROM balances").run().changes;
    const synchronizationRuns = database.prepare("DELETE FROM sync_runs").run().changes;
    database.prepare("DELETE FROM desktop_runs").run();
    database.prepare("UPDATE bank_connections SET last_sync_at = NULL").run();
    return { transactions, balances, synchronizationRuns };
  })();
  await rm(config.rawDataDirectory, { recursive: true, force: true });
  return { exportFiles, ...result };
}
