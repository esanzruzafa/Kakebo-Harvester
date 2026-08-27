import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export function isValidSessionEncryptionKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

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
  PENDING_RECONCILIATION_WINDOW_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(31)
    .default(14),
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
  CARD_IMPORT_PROFILES_PATH: z.string().min(1).optional(),
  UI_SETTINGS_PATH: z.string().min(1).optional(),
  NODE_USE_SYSTEM_CA: z.enum(["0", "1"]).optional(),
  SESSION_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine(
      isValidSessionEncryptionKey,
      "debe contener exactamente 32 bytes codificados en base64 canónico"
    )
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
  pendingReconciliationWindowDays: number;
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
  cardImportProfilesPath: string;
  uiSettingsPath: string;
  useSystemCa: boolean;
  sessionEncryptionKey: Buffer;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function matchesLocalListener(
  environment: AppEnvironment,
  value: string,
  appPort: number,
  pathname: string
): boolean {
  const url = new URL(value);
  const protocol = environment === "production" ? "https:" : "http:";
  return (
    url.protocol === protocol &&
    url.hostname === "localhost" &&
    effectivePort(url) === appPort &&
    url.pathname === pathname &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function isRedirectUrlAllowed(
  environment: AppEnvironment,
  redirectUrl: string,
  appPort: number
): boolean {
  try {
    return matchesLocalListener(environment, redirectUrl, appPort, "/callback");
  } catch {
    return false;
  }
}

export function isAppBaseUrlAllowed(
  environment: AppEnvironment,
  appBaseUrl: string,
  appPort: number
): boolean {
  try {
    return matchesLocalListener(environment, appBaseUrl, appPort, "/");
  } catch {
    return false;
  }
}

export function isApiBaseUrlAllowed(apiBaseUrl: string): boolean {
  try {
    const url = new URL(apiBaseUrl);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function absolutePath(path: string, baseDirectory = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(baseDirectory, path);
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSafeDataLayout(
  databasePath: string,
  rawDataDirectory: string,
  exportDirectory: string
): boolean {
  const dataRoot = comparablePath(dirname(databasePath));
  const raw = comparablePath(rawDataDirectory);
  const exports = comparablePath(exportDirectory);
  return (
    comparablePath(dirname(raw)) === dataRoot &&
    comparablePath(dirname(exports)) === dataRoot &&
    raw !== exports &&
    raw !== dataRoot &&
    exports !== dataRoot
  );
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

  if (!isAppBaseUrlAllowed(config.appEnv, config.appBaseUrl, config.appPort)) {
    throw new ConfigurationError(
      `APP_BASE_URL debe ser ${config.appEnv === "production" ? "https" : "http"}://localhost:${config.appPort}.`
    );
  }

  if (
    !isSafeDataLayout(
      config.databasePath,
      config.rawDataDirectory,
      config.exportDirectory
    )
  ) {
    throw new ConfigurationError(
      "DATABASE_PATH, RAW_DATA_DIRECTORY y EXPORT_DIRECTORY deben compartir la misma carpeta de entorno; raw y exports deben ser subcarpetas hermanas distintas."
    );
  }

  if (!isRedirectUrlAllowed(config.appEnv, config.redirectUrl, config.appPort)) {
    throw new ConfigurationError(
      `ENABLE_BANKING_REDIRECT_URL debe ser ${config.appEnv === "production" ? "https" : "http"}://localhost:${config.appPort}/callback.`
    );
  }

  if (!isApiBaseUrlAllowed(config.apiBaseUrl)) {
    throw new ConfigurationError(
      "ENABLE_BANKING_API_BASE_URL debe usar HTTPS y no puede incluir credenciales, parámetros ni fragmentos."
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

  const privateDirectory = resolve(baseDirectory, "private");
  const privateDefaultPath = resolve(privateDirectory, ".env");
  if (existsSync(privateDefaultPath)) return privateDefaultPath;

  const privateCandidates = [".env.sandbox", ".env.production"]
    .map((filename) => resolve(privateDirectory, filename))
    .filter((path) => existsSync(path));
  if (privateCandidates.length === 1) return privateCandidates[0];
  if (privateCandidates.length > 1) {
    throw new ConfigurationError(
      "Hay varios archivos de entorno privados. Define KAKEBO_ENV_FILE de forma explícita."
    );
  }

  const defaultPath = resolve(baseDirectory, ".env");
  if (existsSync(defaultPath)) return defaultPath;

  const candidates = [".env.sandbox", ".env.production"]
    .map((filename) => resolve(baseDirectory, filename))
    .filter((path) => existsSync(path));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new ConfigurationError(
      "Hay varios archivos de entorno. Define KAKEBO_ENV_FILE de forma explícita."
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
      "No se encontró un archivo de entorno. Usa private/.env.sandbox o private/.env.production y completa sus valores."
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
    apiBaseUrl: env.ENABLE_BANKING_API_BASE_URL.replace(/\/+$/u, ""),
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
    pendingReconciliationWindowDays: env.PENDING_RECONCILIATION_WINDOW_DAYS,
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
    cardImportProfilesPath: absolutePath(
      env.CARD_IMPORT_PROFILES_PATH ?? "config/card-import-profiles.json",
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
