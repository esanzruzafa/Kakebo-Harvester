import { loadConfig } from "./config.js";
import { createDatabase } from "./storage/database.js";
import { EnableBankingClient } from "./enable-banking/client.js";
import { AuthorizationService } from "./auth/authorization-service.js";
import { SyncService } from "./sync/sync-service.js";
import { createLogger } from "./logger.js";
import { runCli } from "./cli.js";
import { KakeboError } from "./errors.js";
import { safeMessage } from "./utils/text.js";
import { configureTlsTrust } from "./tls.js";

async function main(): Promise<void> {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = loadConfig();
    configureTlsTrust(config.useSystemCa);
    database = createDatabase(config.databasePath);
    const logger = createLogger(config.logLevel);
    const client = new EnableBankingClient(config);
    const authorization = new AuthorizationService(config, database, client);
    const sync = new SyncService(config, database, client);
    await runCli(process.argv.slice(2), {
      config,
      database,
      client,
      authorization,
      sync,
      logger
    });
  } catch (error) {
    console.error(`Error: ${safeMessage(error)}`);
    process.exitCode = error instanceof KakeboError ? error.exitCode : 1;
  } finally {
    database?.close();
  }
}

await main();
