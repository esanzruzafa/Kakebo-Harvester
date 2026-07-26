import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  APP_ENV: z.enum(["sandbox", "production"]),
  APP_PORT: z.coerce.number().int().min(1).max(65_535),
  APP_BASE_URL: z.url(),
  ENABLE_BANKING_API_BASE_URL: z.url(),
  ENABLE_BANKING_APPLICATION_ID: z.uuid(),
  ENABLE_BANKING_PRIVATE_KEY_PATH: z.string().min(1),
  ENABLE_BANKING_REDIRECT_URL: z.url(),
  DATABASE_PATH: z.string().min(1),
  RAW_DATA_DIRECTORY: z.string().min(1),
  EXPORT_DIRECTORY: z.string().min(1),
  DEFAULT_COUNTRY: z.string().regex(/^[A-Z]{2}$/),
  DEFAULT_PSU_TYPE: z.enum(["personal", "business"]),
  DEFAULT_LANGUAGE: z.string().min(2).max(8),
  SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365),
  MAX_TRANSACTION_PAGES: z.coerce.number().int().min(1).max(1_000),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
  RETAIN_RAW_DATA: booleanString,
  CSV_SEPARATOR: z.string().length(1),
  EXPORT_KEEP_BACKUP: booleanString,
  APP_TLS_PFX_PATH: z.string().min(1).optional(),
  APP_TLS_PFX_PASSPHRASE_PATH: z.string().min(1).optional(),
  CATEGORIZATION_RULES_PATH: z.string().min(1).optional(),
  ACCOUNTS_CONFIG_PATH: z.string().min(1).optional(),
  CATEGORIES_CONFIG_PATH: z.string().min(1).optional(),
  EXPORT_SETTINGS_PATH: z.string().min(1).optional(),
  UI_SETTINGS_PATH: z.string().min(1).optional(),
  NODE_USE_SYSTEM_CA: z.enum(["0", "1"]).optional(),
  SESSION_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        return Buffer.from(value, "base64").length === 32;
      } catch {
        return false;
      }
    }, "debe contener exactamente 32 bytes codificados en base64")
});

export type AppEnvironment = "sandbox" | "production";
export type PsuType = "personal" | "business";

export interface AppConfig {
  appEnv: AppEnvironment;
  appPort: number;
  appBaseUrl: string;
  apiBaseUrl: string;
  applicationId: string;
  privateKeyPath: string;
  redirectUrl: string;
  databasePath: string;
  rawDataDirectory: string;
  exportDirectory: string;
  defaultCountry: string;
  defaultPsuType: PsuType;
  defaultLanguage: string;
  syncLookbackDays: number;
  maxTransactionPages: number;
  httpTimeoutMs: number;
  logLevel: string;
  retainRawData: boolean;
  csvSeparator: string;
  exportKeepBackup: boolean;
  tlsPfxPath?: string;
  tlsPfxPassphrasePath?: string;
  categorizationRulesPath: string;
  accountsConfigPath: string;
  categoriesConfigPath: string;
  exportSettingsPath: string;
  uiSettingsPath: string;
  useSystemCa: boolean;
  sessionEncryptionKey: Buffer;
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackUrl(url: URL): boolean {
  return loopbackHosts.has(url.hostname);
}

export function isRedirectUrlAllowed(
  environment: AppEnvironment,
  redirectUrl: string
): boolean {
  try {
    const redirect = new URL(redirectUrl);
    return environment === "sandbox"
      ? isLoopbackUrl(redirect) && ["http:", "https:"].includes(redirect.protocol)
      : isLoopbackUrl(redirect) && redirect.protocol === "https:";
  } catch {
    return false;
  }
}

function absolutePath(path: string, baseDirectory = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(baseDirectory, path);
}

function assertEnvironmentIsolation(config: AppConfig): void {
  const expected = config.appEnv;
  const paths = [
    config.privateKeyPath,
    config.databasePath,
    config.rawDataDirectory,
    config.exportDirectory,
    ...(config.tlsPfxPath ? [config.tlsPfxPath] : []),
    ...(config.tlsPfxPassphrasePath ? [config.tlsPfxPassphrasePath] : [])
  ];

  if (!paths.every((path) => path.toLowerCase().includes(expected))) {
    throw new ConfigurationError(
      `Las rutas de clave, base de datos, raw y exportación deben incluir "${expected}".`
    );
  }
  const otherEnvironment = expected === "sandbox" ? "production" : "sandbox";
  if (paths.some((path) => path.toLowerCase().includes(otherEnvironment))) {
    throw new ConfigurationError(
      `Las rutas de ${expected} no pueden contener la etiqueta "${otherEnvironment}".`
    );
  }

  const appBaseUrl = new URL(config.appBaseUrl);
  if (!isLoopbackUrl(appBaseUrl)) {
    throw new ConfigurationError(
      "APP_BASE_URL debe apuntar a localhost porque Kakebo Harvester se ejecuta localmente."
    );
  }

  if (!isRedirectUrlAllowed(config.appEnv, config.redirectUrl)) {
    throw new ConfigurationError(
      config.appEnv === "sandbox"
        ? "El callback de sandbox debe apuntar a localhost."
        : "El callback de producción debe usar HTTPS y apuntar a localhost."
    );
  }

  if (
    config.appEnv === "production" &&
    (!config.tlsPfxPath || !config.tlsPfxPassphrasePath)
  ) {
    throw new ConfigurationError(
      "Producción requiere APP_TLS_PFX_PATH y APP_TLS_PFX_PASSPHRASE_PATH."
    );
  }
}

export function resolveEnvironmentFile(
  explicitPath = process.env["KAKEBO_ENV_FILE"],
  baseDirectory = process.cwd()
): string | undefined {
  if (explicitPath) {
    const path = absolutePath(explicitPath, baseDirectory);
    if (!existsSync(path)) {
      throw new ConfigurationError(`No existe el archivo de entorno indicado: ${path}.`);
    }
    return path;
  }

  const defaultPath = resolve(baseDirectory, ".env");
  if (existsSync(defaultPath)) return defaultPath;

  const candidates = [".env.sandbox", ".env.production"]
    .map((filename) => resolve(baseDirectory, filename))
    .filter((path) => existsSync(path));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new ConfigurationError(
      "Hay varios archivos de entorno. Define KAKEBO_ENV_FILE como .env.sandbox o .env.production."
    );
  }
  return undefined;
}

export function loadConfig(
  envFile?: string,
  options: { overrideEnvironment?: boolean } = {}
): AppConfig {
  const selectedEnvironmentFile = resolveEnvironmentFile(envFile);
  if (selectedEnvironmentFile) {
    loadDotenv({
      path: selectedEnvironmentFile,
      override: options.overrideEnvironment ?? false,
      quiet: true
    });
  } else if (!process.env["APP_ENV"]) {
    throw new ConfigurationError(
      "No se encontró .env, .env.sandbox ni .env.production. Copia .env.example y completa sus valores."
    );
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Configuración no válida: ${details}`);
  }

  const env = result.data;
  const baseDirectory = selectedEnvironmentFile
    ? dirname(selectedEnvironmentFile)
    : process.cwd();
  const tlsPfxPath = env.APP_TLS_PFX_PATH
    ? absolutePath(env.APP_TLS_PFX_PATH, baseDirectory)
    : undefined;
  const tlsPfxPassphrasePath = env.APP_TLS_PFX_PASSPHRASE_PATH
    ? absolutePath(env.APP_TLS_PFX_PASSPHRASE_PATH, baseDirectory)
    : undefined;
  const config: AppConfig = {
    appEnv: env.APP_ENV,
    appPort: env.APP_PORT,
    appBaseUrl: env.APP_BASE_URL,
    apiBaseUrl: env.ENABLE_BANKING_API_BASE_URL.replace(/\/$/, ""),
    applicationId: env.ENABLE_BANKING_APPLICATION_ID,
    privateKeyPath: absolutePath(env.ENABLE_BANKING_PRIVATE_KEY_PATH, baseDirectory),
    redirectUrl: env.ENABLE_BANKING_REDIRECT_URL,
    databasePath: absolutePath(env.DATABASE_PATH, baseDirectory),
    rawDataDirectory: absolutePath(env.RAW_DATA_DIRECTORY, baseDirectory),
    exportDirectory: absolutePath(env.EXPORT_DIRECTORY, baseDirectory),
    defaultCountry: env.DEFAULT_COUNTRY,
    defaultPsuType: env.DEFAULT_PSU_TYPE,
    defaultLanguage: env.DEFAULT_LANGUAGE,
    syncLookbackDays: env.SYNC_LOOKBACK_DAYS,
    maxTransactionPages: env.MAX_TRANSACTION_PAGES,
    httpTimeoutMs: env.HTTP_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
    retainRawData: env.RETAIN_RAW_DATA,
    csvSeparator: env.CSV_SEPARATOR,
    exportKeepBackup: env.EXPORT_KEEP_BACKUP,
    ...(tlsPfxPath ? { tlsPfxPath } : {}),
    ...(tlsPfxPassphrasePath ? { tlsPfxPassphrasePath } : {}),
    categorizationRulesPath: absolutePath(
      env.CATEGORIZATION_RULES_PATH ?? "config/categorization-rules.json",
      baseDirectory
    ),
    accountsConfigPath: absolutePath(
      env.ACCOUNTS_CONFIG_PATH ?? "config/accounts.json",
      baseDirectory
    ),
    categoriesConfigPath: absolutePath(
      env.CATEGORIES_CONFIG_PATH ?? "config/categories.json",
      baseDirectory
    ),
    exportSettingsPath: absolutePath(
      env.EXPORT_SETTINGS_PATH ?? "config/export-settings.json",
      baseDirectory
    ),
    uiSettingsPath: absolutePath(
      env.UI_SETTINGS_PATH ?? "config/ui-settings.json",
      baseDirectory
    ),
    useSystemCa:
      env.NODE_USE_SYSTEM_CA === undefined
        ? process.platform === "win32"
        : env.NODE_USE_SYSTEM_CA === "1",
    sessionEncryptionKey: Buffer.from(env.SESSION_ENCRYPTION_KEY, "base64")
  };

  assertEnvironmentIsolation(config);
  return config;
}

export function readPrivateKey(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigurationError(`No se puede leer la clave privada en ${path}.`, {
      cause: error
    });
  }
}
