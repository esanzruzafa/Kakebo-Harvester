import type { Logger } from "pino";
import { loadConfig, type AppConfig } from "../config.js";
import { EnableBankingClient } from "../enable-banking/client.js";
import { AuthorizationService } from "../auth/authorization-service.js";
import { SyncService } from "../sync/sync-service.js";
import { createLogger } from "../logger.js";
import {
  createDatabase,
  type SqliteDatabase
} from "../storage/database.js";
import { DesktopRunRepository } from "../storage/repositories/desktop-run-repository.js";
import { SYNCHRONIZATION_LOCK_STALE_AFTER_MS } from "../sync/sync-runner.js";
import { configureTlsTrust } from "../tls.js";

export interface KakeboApplication {
  config: AppConfig;
  database: SqliteDatabase;
  client: EnableBankingClient;
  authorization: AuthorizationService;
  sync: SyncService;
  logger: Logger;
  close: () => void;
}

export function createKakeboApplication(
  envFile?: string,
  options: { overrideEnvironment?: boolean } = {}
): KakeboApplication {
  const config = loadConfig(envFile, options);
  configureTlsTrust(config.useSystemCa);
  const database = createDatabase(config.databasePath);
  try {
    new DesktopRunRepository(database).recoverInterruptedRuns(
      new Date(Date.now() - SYNCHRONIZATION_LOCK_STALE_AFTER_MS)
    );
    const logger = createLogger(config.logLevel);
    const client = new EnableBankingClient(config);
    const authorization = new AuthorizationService(config, database, client);
    const sync = new SyncService(config, database, client);
    return {
      config,
      database,
      client,
      authorization,
      sync,
      logger,
      close: () => database.close()
    };
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the initialization failure that caused the cleanup.
    }
    throw error;
  }
}
