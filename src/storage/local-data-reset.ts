import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
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
  clearRawData: async (directory) => {
    try {
      if ((await lstat(directory)).isSymbolicLink()) {
        throw new Error("Refusing to clear a symbolic link raw-data directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const hasGitMarker = entries.some(
      (entry) => entry.name === ".gitkeep" && entry.isFile()
    );
    for (const entry of entries) {
      if (entry.name === ".gitkeep" && entry.isFile()) continue;
      await rm(join(directory, entry.name), { recursive: true, force: true });
    }
    if (!hasGitMarker) {
      await rm(directory, { recursive: true, force: true });
    }
  }
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
    database.prepare("DELETE FROM card_import_source_rows").run();
    database.prepare("DELETE FROM transactions_raw").run();
    const balances = database.prepare("DELETE FROM balances").run().changes;
    const synchronizationRuns = database.prepare("DELETE FROM sync_runs").run().changes;
    const desktopRuns = database.prepare("DELETE FROM desktop_runs").run().changes;
    database
      .prepare(
        `UPDATE accounts SET
           last_error_at = NULL, last_error_code = NULL,
           last_error_message_safe = NULL`
      )
      .run();
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
