import { rm } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { clearGeneratedExportFiles } from "../export/csv-exporter.js";
import type { SqliteDatabase } from "./database.js";

export interface LocalDataResetResult {
  exportFiles: number;
  transactions: number;
  balances: number;
  synchronizationRuns: number;
  desktopRuns: number;
  cleanupWarnings: Array<"exports" | "raw-data">;
}

interface LocalDataCleanup {
  clearExports: (config: AppConfig) => Promise<number>;
  clearRawData: (directory: string) => Promise<void>;
}

const defaultCleanup: LocalDataCleanup = {
  clearExports: clearGeneratedExportFiles,
  clearRawData: async (directory) => rm(directory, { recursive: true, force: true })
};

/**
 * Removes locally collected financial history while preserving bank access and
 * user-maintained configuration.
 */
export async function resetLocalData(
  config: AppConfig,
  database: SqliteDatabase,
  cleanup: LocalDataCleanup = defaultCleanup
): Promise<LocalDataResetResult> {
  const cleanupWarnings: LocalDataResetResult["cleanupWarnings"] = [];
  const result = database.transaction(() => {
    const transactions = database.prepare("DELETE FROM transactions").run().changes;
    database.prepare("DELETE FROM transactions_raw").run();
    const balances = database.prepare("DELETE FROM balances").run().changes;
    const synchronizationRuns = database.prepare("DELETE FROM sync_runs").run().changes;
    const desktopRuns = database.prepare("DELETE FROM desktop_runs").run().changes;
    database.prepare("UPDATE bank_connections SET last_sync_at = NULL").run();
    return { transactions, balances, synchronizationRuns, desktopRuns };
  })();
  let exportFiles = 0;
  try {
    exportFiles = await cleanup.clearExports(config);
  } catch {
    cleanupWarnings.push("exports");
  }
  try {
    await cleanup.clearRawData(config.rawDataDirectory);
  } catch {
    cleanupWarnings.push("raw-data");
  }
  return { exportFiles, ...result, cleanupWarnings };
}
