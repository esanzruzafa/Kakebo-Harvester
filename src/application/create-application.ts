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
}
