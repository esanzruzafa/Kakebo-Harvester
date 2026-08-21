import type { AppConfig, PsuType } from "./config.js";
import type { SqliteDatabase } from "./storage/database.js";
import type { EnableBankingClient } from "./enable-banking/client.js";
import type { AuthorizationService } from "./auth/authorization-service.js";
import type {
  SyncExecutionContext,
  SyncService,
  SyncSummary
} from "./sync/sync-service.js";
import { SynchronizationLock, SyncRunner } from "./sync/sync-runner.js";
import { getSyncWindow } from "./sync/sync-window.js";
import { CsvExporter } from "./export/csv-exporter.js";
import { AccountRepository } from "./storage/repositories/account-repository.js";
import { startServer } from "./server.js";
import { runDoctor } from "./doctor.js";
import { disconnectBankConnection } from "./auth/disconnect-service.js";
import type { Logger } from "pino";

interface ParsedArguments {
  command: string;
  options: Map<string, string | true>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const options = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) throw new Error(`Argumento inesperado: ${item ?? ""}`);
    const name = item.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      options.set(name, value);
      index += 1;
    } else {
      options.set(name, true);
    }
  }
  return { command, options };
}

function value(
  options: Map<string, string | true>,
  name: string,
  fallback?: string
): string | undefined {
  const result = options.get(name);
  return typeof result === "string" ? result : fallback;
}

function required(options: Map<string, string | true>, name: string): string {
  const result = value(options, name);
  if (!result) throw new Error(`Falta la opción obligatoria --${name}.`);
  return result;
}

function cliSyncContext(
  options: Map<string, string | true>,
  config: AppConfig
): SyncExecutionContext {
  if (!options.has("online")) return {};
  return {
    psuHeaders: {
      userAgent: `Kakebo-Harvester-CLI/0.1.0 (${process.platform}; Node/${process.versions.node})`,
      acceptLanguage: config.defaultLanguage
    },
    ...(options.has("retry-rate-limit")
      ? { allowRateLimitOverride: true }
      : {})
  };
}

function printSummary(summary: SyncSummary): void {
  console.table([
    {
      pages: summary.pages,
      received: summary.received,
      inserted: summary.inserted,
      updated: summary.updated,
      duplicates: summary.duplicates,
      pendingReconciled: summary.pendingReconciled
    }
  ]);
}

async function withSynchronizationLock<Result>(
  database: SqliteDatabase,
  operation: () => Promise<Result>
): Promise<Result> {
  const lock = new SynchronizationLock(database);
  lock.acquire();
  try {
    return await operation();
  } finally {
    lock.release();
  }
}

function printHelp(): void {
  console.log(`Kakebo Harvester (solo lectura)

Comandos:
  doctor
  banks --country ES [--search texto]
  connect --bank "Banco" [--country ES] [--psu-type personal]
  server
  connections
  accounts
  sync-accounts [--online] [--retry-rate-limit]
  sync-balances [--online] [--retry-rate-limit]
  sync-transactions [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--online] [--retry-rate-limit]
  initial-sync --from YYYY-MM-DD [--to YYYY-MM-DD] [--online] [--retry-rate-limit]
  sync-all [--online] [--retry-rate-limit]
  export
  disconnect --connection "alias"`);
}

interface CliDependencies {
  config: AppConfig;
  database: SqliteDatabase;
  client: EnableBankingClient;
  authorization: AuthorizationService;
  sync: SyncService;
  logger: Logger;
}

export async function runCli(argv: string[], dependencies: CliDependencies): Promise<void> {
  const { config, database, client, authorization, sync, logger } = dependencies;
  const { command, options } = parseArguments(argv);
  const syncRunner = new SyncRunner(config, database, sync);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "doctor": {
      const checks = await runDoctor(config, client);
      console.table(checks);
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
      return;
    }
    case "banks": {
      const country = value(options, "country", config.defaultCountry) ?? config.defaultCountry;
      const search = value(options, "search")?.toLocaleLowerCase();
      const banks = await client.listBanks(country);
      console.table(
        banks
          .filter((bank) => !search || bank.name.toLocaleLowerCase().includes(search))
          .map((bank) => ({
            name: bank.name,
            country: bank.country,
            psuTypes: bank.psu_types.join(", "),
            authentication: bank.auth_methods
              .map((method) => method.title ?? method.name ?? method.approach)
              .join(", ")
          }))
      );
      return;
    }
    case "connect": {
      const psuType = value(options, "psu-type", config.defaultPsuType) as PsuType;
      if (!["personal", "business"].includes(psuType)) {
        throw new Error("--psu-type debe ser personal o business.");
      }
      const result = await authorization.connect({
        bankSearch: required(options, "bank"),
        country: value(options, "country", config.defaultCountry) ?? config.defaultCountry,
        psuType
      });
      console.log(`Conexión: ${result.connectionAlias}`);
      console.log(`Abre esta URL oficial para autorizar:\n${result.url}`);
      console.log(
        "Introduce tus credenciales únicamente en la pantalla oficial del banco. El callback local debe estar ejecutándose con: npm run cli -- server"
      );
      return;
    }
    case "server":
      await startServer(config, authorization);
      return;
    case "connections": {
      const rows = database
        .prepare(
          `SELECT alias, bank_name AS bank, bank_country AS country, psu_type,
                  status, valid_until, last_sync_at, reauthorization_required,
                  retry_after_at, online_retry_used,
                  required_psu_headers_json, error_code, error_message_safe
           FROM bank_connections ORDER BY created_at`
        )
        .all();
      console.table(rows);
      return;
    }
    case "accounts": {
      const accounts = new AccountRepository(database).listActive().map((account) => ({
        bank: account.bank_name,
        connection: account.connection_alias,
        account: account.account_alias ?? account.display_name ?? account.name,
        masked: account.iban_masked,
        currency: account.currency,
        type: account.product_type ?? account.account_type
      }));
      console.table(accounts);
      return;
    }
    case "sync-accounts": {
      const count = await withSynchronizationLock(database, () =>
        sync.syncAccounts(cliSyncContext(options, config))
      );
      logger.info({ count }, "Account synchronization completed");
      console.log(`Cuentas sincronizadas: ${count}`);
      return;
    }
    case "sync-balances": {
      const count = await withSynchronizationLock(database, () =>
        sync.syncBalances(undefined, cliSyncContext(options, config))
      );
      logger.info({ count }, "Balance synchronization completed");
      console.log(`Saldos guardados: ${count}`);
      return;
    }
    case "sync-transactions": {
      const window = getSyncWindow(
        config.syncLookbackDays,
        value(options, "from"),
        value(options, "to")
      );
      const summary = await withSynchronizationLock(database, () =>
        sync.syncTransactions(
          window.dateFrom,
          window.dateTo,
          cliSyncContext(options, config)
        )
      );
      logger.info({ ...summary, ...window }, "Transaction synchronization completed");
      printSummary(summary);
      return;
    }
    case "initial-sync": {
      const window = getSyncWindow(
        config.syncLookbackDays,
        required(options, "from"),
        value(options, "to")
      );
      const context = cliSyncContext(options, config);
      const result = await syncRunner.run(
        {
          steps: ["accounts", "balances", "transactions", "export"],
          dateFrom: window.dateFrom,
          dateTo: window.dateTo
        },
        context
      );
      console.log(
        `Accounts: ${result.accounts ?? 0}; balances: ${result.balances ?? 0}; export: ${result.export?.path ?? "not generated"}`
      );
      printSummary(result.transactions ?? emptySyncSummary());
      return;
    }
    case "sync-all": {
      const window = getSyncWindow(config.syncLookbackDays);
      const context = cliSyncContext(options, config);
      const result = await syncRunner.run(
        {
          steps: ["accounts", "balances", "transactions", "export"],
          dateFrom: window.dateFrom,
          dateTo: window.dateTo
        },
        context
      );
      const summary = result.transactions ?? emptySyncSummary();
      logger.info(
        {
          accounts: result.accounts ?? 0,
          balances: result.balances ?? 0,
          ...summary,
          exportRows: result.export?.rows ?? 0
        },
        "Full synchronization completed"
      );
      console.log(
        `Accounts: ${result.accounts ?? 0}; balances: ${result.balances ?? 0}; movements received: ${summary.received}; export: ${result.export?.path ?? "not generated"}`
      );
      printSummary(summary);
      return;
    }
    case "export": {
      const result = await withSynchronizationLock(database, () =>
        new CsvExporter(config, database).export()
      );
      console.log(`Export generated: ${result.path} (${result.rows} rows)`);
      return;
    }
    case "disconnect": {
      const alias = required(options, "connection");
      const connection = database
        .prepare(
          `SELECT id FROM bank_connections
           WHERE alias = ? AND environment = ? AND provider = 'enable-banking'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(alias, config.appEnv) as { id: string } | undefined;
      if (!connection) throw new Error(`No existe la conexión "${alias}".`);
      const result = await disconnectBankConnection({
        config,
        database,
        client,
        connectionId: connection.id
      });
      if (result.remoteRevocationAttempted && !result.remoteRevoked) {
        logger.warn("Remote session could not be revoked; continuing with local disconnect");
      }
      console.log(
        "Conexión revocada localmente. Los movimientos históricos se han conservado. Comprueba también la revocación del consentimiento en el banco o en Enable Banking."
      );
      return;
    }
    default:
      throw new Error(`Comando desconocido: ${command}. Usa "help" para ver los comandos.`);
  }
}

function emptySyncSummary(): SyncSummary {
  return {
    pages: 0,
    received: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    pendingReconciled: 0
  };
}
