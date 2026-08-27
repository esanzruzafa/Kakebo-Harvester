import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions
} from "electron";
import { z } from "zod";
import {
  CardImportService,
  cardImportRequestSchema
} from "../cards/card-import-service.js";
import {
  createKakeboApplication,
  type KakeboApplication
} from "../application/create-application.js";
import { resolveEnvironmentFile } from "../config.js";
import type { AuthorizationCompletionResult } from "../auth/authorization-service.js";
import { disconnectBankConnection } from "../auth/disconnect-service.js";
import { runDoctor } from "../doctor.js";
import { KakeboError } from "../errors.js";
import {
  CsvExporter,
  defaultExportSettings,
  exportOutputPath
} from "../export/csv-exporter.js";
import { AccountsConfigStore } from "../settings/accounts-config-store.js";
import {
  CardImportProfilesStore,
  cardImportProfileSchema
} from "../settings/card-import-profiles-store.js";
import {
  CategoriesStore
} from "../settings/categories-store.js";
import {
  CategorizationRulesStore
} from "../settings/categorization-rules-store.js";
import {
  ExportSettingsStore,
  exportSettingsSchema
} from "../settings/export-settings-store.js";
import {
  LocalizationStore,
  type AppLanguage
} from "../settings/localization-store.js";
import { startCallbackServer } from "../server.js";
import { completeDesktopAuthorization } from "./authorization-callback.js";
import { AccountRepository } from "../storage/repositories/account-repository.js";
import { resetLocalData } from "../storage/local-data-reset.js";
import { DesktopRunRepository } from "../storage/repositories/desktop-run-repository.js";
import { getSyncWindow } from "../sync/sync-window.js";
import type {
  AccountFailureDecision,
  AccountSyncFailure
} from "../sync/sync-service.js";
import {
  SynchronizationLock,
  SyncRunner,
  type SyncProgressEvent,
  type SyncRequest
} from "../sync/sync-runner.js";
import { monthsAgoIso, todayIso } from "../utils/dates.js";
import { safeMessage } from "../utils/text.js";
import { configureTlsTrust } from "../tls.js";
import {
  isUsableLocalHttpsCertificate,
  tlsSetupScriptPath
} from "./local-https.js";
import { saveAccountSettings } from "./account-settings.js";
import {
  CategorizationReferenceError,
  saveCategorizationSettings
} from "./categorization-settings.js";
import type {
  AuthorizationUiResult,
  BankOption,
  ConnectBankRequest,
  ConnectionView,
  DesktopBootstrap,
  OpenPathTarget
} from "./contracts.js";

const UI_ZOOM_FACTOR = 0.945;

const syncRequestSchema = z.object({
  steps: z
    .array(z.enum(["accounts", "balances", "transactions", "export"]))
    .min(1),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  allowRateLimitOverride: z.boolean().optional()
});

const accountFailureDecisionSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(["continue", "stop"])
});

const editableAccountSchema = z.object({
  id: z.string().min(1),
  identificationHash: z.string().nullable(),
  bank: z.string(),
  connection: z.string(),
  account: z.string(),
  masked: z.string().nullable(),
  currency: z.string().nullable(),
  productType: z.string().nullable(),
  alias: z.string().max(120),
  providerActive: z.boolean(),
  syncEnabled: z.boolean(),
  exportEnabled: z.boolean(),
  lastError: z
    .object({
      at: z.string(),
      code: z.string(),
      message: z.string()
    })
    .nullable()
});

const countryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/)
  .transform((value) => value.toUpperCase());

const listBanksSchema = z.object({
  country: countryCodeSchema
});

const connectBankSchema = z.object({
  bankName: z.string().trim().min(1).max(200),
  country: countryCodeSchema,
  psuType: z.enum(["personal", "business"])
});

const auditHistoryLimitSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(20),
  z.literal(50),
  z.literal(100)
]);

const openPathTargetSchema = z.enum([
  "root",
  "export-directory",
  "export-file",
  "categorization-rules",
  "accounts-config",
  "categories-config",
  "export-settings",
  "card-import-profiles",
  "ui-settings"
]);

const execFileAsync = promisify(execFile);

class AuthorizationCoordinator {
  private readonly inProgress = new Set<string>();
  private cancelledReason: string | undefined;
  private readonly waiters = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  public constructor(
    private readonly application: KakeboApplication,
    private readonly publish: (result: AuthorizationUiResult) => void
  ) {}

  public isInProgress(connectionId: string): boolean {
    return this.inProgress.has(connectionId);
  }

  public complete(result: AuthorizationCompletionResult): void {
    this.publish({
      connectionId: result.connectionId,
      bankName: result.bankName,
      status: result.status,
      ...(result.message ? { message: result.message } : {})
    });
    const waiter = this.waiters.get(result.connectionId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waiters.delete(result.connectionId);
    if (result.status === "authorized") {
      waiter.resolve();
    } else {
      waiter.reject(
        new Error(
          result.message ??
            tr(
              "error.authorizationNotCompleted",
              "The bank authorization was not completed."
            )
        )
      );
    }
  }

  private wait(connectionId: string): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      if (this.waiters.has(connectionId)) {
        rejectPromise(
          new Error(
            tr(
              "error.authorizationInProgress",
              "A bank authorization is already in progress."
            )
          )
        );
        return;
      }
      const timeout = setTimeout(() => {
        this.waiters.delete(connectionId);
        rejectPromise(
          new Error(
            tr(
              "error.authorizationTimedOut",
              "Bank authorization timed out. Start the connection again."
            )
          )
        );
      }, 15 * 60_000);
      this.waiters.set(connectionId, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout
      });
    });
  }

  private async openAndWait(authorization: {
    connectionId: string;
    url: string;
  }): Promise<void> {
    const url = new URL(authorization.url);
    if (url.protocol !== "https:") {
      throw new Error(
        tr(
          "error.unsafeAuthorizationUrl",
          "The provider returned an unsafe authorization URL."
        )
      );
    }
    const completion = this.wait(authorization.connectionId);
    try {
      await shell.openExternal(url.toString());
    } catch (error) {
      const waiter = this.waiters.get(authorization.connectionId);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.waiters.delete(authorization.connectionId);
        waiter.reject(error instanceof Error ? error : new Error(safeMessage(error)));
      }
      await completion.catch(() => undefined);
      throw error;
    }
    await completion;
  }

  public async connect(input: ConnectBankRequest): Promise<void> {
    if (this.cancelledReason) throw new Error(this.cancelledReason);
    const authorization = await this.application.authorization.connect({
      bankSearch: input.bankName,
      country: input.country,
      psuType: input.psuType
    });
    if (this.inProgress.has(authorization.connectionId)) {
      throw new Error(
        tr(
          "error.authorizationInProgress",
          "A bank authorization is already in progress."
        )
      );
    }
    this.inProgress.add(authorization.connectionId);
    try {
      if (this.cancelledReason) throw new Error(this.cancelledReason);
      await this.openAndWait(authorization);
    } catch (error) {
      this.application.authorization.abandonConnection(
        authorization.connectionId
      );
      throw error;
    } finally {
      this.inProgress.delete(authorization.connectionId);
    }
  }

  public async reauthorize(connectionIds: readonly string[]): Promise<void> {
    for (const connectionId of [...new Set(connectionIds)]) {
      if (this.cancelledReason) throw new Error(this.cancelledReason);
      if (this.inProgress.has(connectionId)) {
        throw new Error(
          tr(
            "error.authorizationInProgress",
            "A bank authorization is already in progress."
          )
        );
      }
      this.inProgress.add(connectionId);
      try {
        const authorization = await this.application.authorization.reauthorize(
          connectionId
        );
        if (this.cancelledReason) throw new Error(this.cancelledReason);
        await this.openAndWait(authorization);
      } finally {
        this.inProgress.delete(connectionId);
      }
    }
  }

  public cancelAll(reason: string): void {
    this.cancelledReason = reason;
    for (const [connectionId, waiter] of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
      this.waiters.delete(connectionId);
    }
  }
}

let domainApplication: KakeboApplication | undefined;
let callbackServer: Awaited<ReturnType<typeof startCallbackServer>> | undefined;
let mainWindow: BrowserWindow | undefined;
let auditWindow: BrowserWindow | undefined;
let loadingWindow: BrowserWindow | undefined;
let closeConfirmed = false;
let pendingAccountFailureDecision:
  | {
      requestId: string;
      resolve: (decision: AccountFailureDecision) => void;
    }
  | undefined;
let rootDirectory = "";
let environmentFile = "";
let coordinator: AuthorizationCoordinator | undefined;
let localization: LocalizationStore | undefined;
let quitting = false;
let cleanupComplete = false;
let activeSync: Promise<unknown> | undefined;
let shutdownPromise: Promise<void> | undefined;
const activeOperations = new Set<Promise<unknown>>();

function tr(key: string, fallback: string): string {
  return localization?.translate(key, fallback) ?? fallback;
}

function trf(
  key: string,
  fallback: string,
  values: Record<string, string | number>
): string {
  let result = tr(key, fallback);
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}

function desktopArguments(): string[] {
  return process.argv.slice(app.isPackaged ? 1 : 2);
}

function findEnvironmentFile(): string {
  const explicit = process.env["KAKEBO_ENV_FILE"];
  if (explicit) {
    const selected = resolveEnvironmentFile(explicit, process.cwd());
    if (selected) return selected;
    throw new Error("The explicitly selected environment file could not be resolved.");
  }
  const portableDirectory = process.env["PORTABLE_EXECUTABLE_DIR"];
  const environmentCandidates = (directory: string): string[] => [
    join(directory, "private", ".env.production"),
    join(directory, ".env.production")
  ];
  const candidates = [
    ...(portableDirectory
      ? environmentCandidates(portableDirectory)
      : []),
    ...environmentCandidates(app.getPath("userData")),
    ...environmentCandidates(process.cwd()),
    ...environmentCandidates(dirname(process.execPath))
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error(
      "No .env.production file was found. Place it in private next to the portable executable or in the application data directory."
    );
  }
  return selected;
}

function scheduledExecutable(): string {
  return process.env["PORTABLE_EXECUTABLE_FILE"] ?? process.execPath;
}

function sendToRenderer(channel: string, value: unknown): void {
  const window = mainWindow;
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function resolvePendingAccountFailureDecision(
  decision: AccountFailureDecision
): boolean {
  const pending = pendingAccountFailureDecision;
  if (!pending) return false;
  pendingAccountFailureDecision = undefined;
  pending.resolve(decision);
  return true;
}

async function requestAccountFailureDecision(
  failure: AccountSyncFailure
): Promise<AccountFailureDecision> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return "stop";
  resolvePendingAccountFailureDecision("stop");
  const requestId = randomUUID();
  return await new Promise<AccountFailureDecision>((resolve) => {
    pendingAccountFailureDecision = { requestId, resolve };
    window.webContents.send("sync:account-failure", { requestId, ...failure });
  });
}

async function listenForCallbacks(
  application: KakeboApplication
): Promise<Awaited<ReturnType<typeof startCallbackServer>>> {
  return await startCallbackServer(
    application.config,
    {
      complete: async (callback) =>
        await completeDesktopAuthorization({
          database: application.database,
          authorization: application.authorization,
          isConnectionInProgress: (connectionId) =>
            coordinator?.isInProgress(connectionId) === true,
          callback
        })
    },
    {
      onAuthorizationResult: (result) => coordinator?.complete(result),
      getLanguage: () => localization?.getLanguage() ?? "en",
      translate: (key, fallback) => tr(key, fallback)
    }
  );
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const window = mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame?.url !== window.webContents.getURL()
  ) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
  if (quitting) throw new Error("The application is closing.");
}

function assertAuditSender(event: IpcMainInvokeEvent): void {
  const window = auditWindow;
  if (
    !window ||
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame?.url !== window.webContents.getURL()
  ) {
    throw new Error("Rejected IPC request from an untrusted audit window.");
  }
  if (quitting) throw new Error("The application is closing.");
}

function assertApplicationSender(event: IpcMainInvokeEvent): void {
  const candidates = [mainWindow, auditWindow].filter(
    (window): window is BrowserWindow => Boolean(window && !window.isDestroyed())
  );
  const trusted = candidates.some(
    (window) =>
      event.sender.id === window.webContents.id &&
      event.senderFrame?.url === window.webContents.getURL()
  );
  if (!trusted) {
    throw new Error("Rejected IPC request from an untrusted application window.");
  }
  if (quitting) throw new Error("The application is closing.");
}

function trackOperation<Result>(operation: Promise<Result>): Promise<Result> {
  activeOperations.add(operation);
  void operation
    .finally(() => activeOperations.delete(operation))
    .catch(() => undefined);
  return operation;
}

async function withSynchronizationLock<Result>(
  application: KakeboApplication,
  operation: () => Promise<Result> | Result
): Promise<Result> {
  const lock = new SynchronizationLock(application.database);
  lock.acquire();
  try {
    return await operation();
  } finally {
    lock.release();
  }
}

async function generateLocalHttps(
  application: KakeboApplication,
  force: boolean
): Promise<void> {
  if (!application.config.tlsPfxPath || !application.config.tlsPfxPassphrasePath) {
    throw new Error("APP_TLS_PFX_PATH and APP_TLS_PFX_PASSPHRASE_PATH are required.");
  }
  const argumentsList = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    tlsSetupScriptPath({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    }),
    "-PrivateDirectory",
    dirname(application.config.tlsPfxPath),
    "-PfxPath",
    application.config.tlsPfxPath,
    "-PassphrasePath",
    application.config.tlsPfxPassphrasePath,
    "-CaThumbprintPath",
    join(dirname(application.config.tlsPfxPath), "local-https-production-ca.thumbprint"),
    ...(force ? ["-Force"] : [])
  ];
  await execFileAsync("powershell.exe", argumentsList, {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1_000_000
  });
  configureTlsTrust(application.config.useSystemCa);
}

async function localHttpsIsTrusted(
  application: KakeboApplication
): Promise<boolean> {
  if (
    !application.config.tlsPfxPath ||
    !application.config.tlsPfxPassphrasePath ||
    !existsSync(application.config.tlsPfxPath) ||
    !existsSync(application.config.tlsPfxPassphrasePath)
  ) {
    return false;
  }
  if (process.platform !== "win32") return true;
  const thumbprintPath = join(
    dirname(application.config.tlsPfxPath),
    "local-https-production-ca.thumbprint"
  );
  try {
    const thumbprint = (await readFile(thumbprintPath, "utf8")).trim();
    if (!/^[A-Fa-f0-9]{40}$/u.test(thumbprint)) return false;
    const certificatePath = `Cert:\\CurrentUser\\Root\\${thumbprint}`;
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Test-Path -LiteralPath '${certificatePath}') { exit 0 } else { exit 1 }`
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 100_000
      }
    );
    return await isUsableLocalHttpsCertificate({
      pfxPath: application.config.tlsPfxPath,
      passphrasePath: application.config.tlsPfxPassphrasePath
    });
  } catch {
    return false;
  }
}

async function ensureLocalHttps(application: KakeboApplication): Promise<boolean> {
  if (await localHttpsIsTrusted(application)) return true;
  const options: MessageBoxOptions = {
    type: "info",
    title: "Kakebo Harvester",
    message: tr(
      "dialog.httpsRequired.message",
      "This computer needs local HTTPS access."
    ),
    detail: tr(
      "dialog.httpsRequired.detail",
      "Kakebo Harvester will generate a certificate for this Windows user. It does not change the Enable Banking configuration."
    ),
    buttons: [
      tr("common.cancel", "Cancel"),
      tr("dialog.httpsRequired.confirm", "Prepare HTTPS")
    ],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  };
  const confirmation =
    loadingWindow && !loadingWindow.isDestroyed()
      ? await dialog.showMessageBox(loadingWindow, options)
      : await dialog.showMessageBox(options);
  if (confirmation.response !== 1) {
    return false;
  }
  await generateLocalHttps(application, true);
  if (!(await localHttpsIsTrusted(application))) {
    throw new Error(
      "The local HTTPS certificate was generated but is not trusted by this Windows user."
    );
  }
  return true;
}

function connections(application: KakeboApplication): ConnectionView[] {
  const rows = application.database
    .prepare(
      `SELECT id, bank_name, alias, status, valid_until, last_sync_at,
              reauthorization_required, retry_after_at, error_code,
              error_message_safe, online_retry_used
       FROM bank_connections
       WHERE environment = ?
         AND provider = 'enable-banking'
         AND status <> 'REVOKED'
       ORDER BY created_at`
    )
    .all(application.config.appEnv) as Array<{
    id: string;
    bank_name: string;
    alias: string;
    status: string;
    valid_until: string | null;
    last_sync_at: string | null;
    reauthorization_required: number;
    retry_after_at: string | null;
    error_code: string | null;
    error_message_safe: string | null;
    online_retry_used: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    bank: row.bank_name,
    alias: row.alias,
    status: row.status,
    validUntil: row.valid_until,
    lastSyncAt: row.last_sync_at,
    reauthorizationRequired: row.reauthorization_required === 1,
    retryAfterAt: row.retry_after_at,
    errorCode: row.error_code,
    errorMessage: row.error_message_safe,
    onlineRetryUsed: row.online_retry_used === 1
  }));
}

function exportSettingsStore(application: KakeboApplication): ExportSettingsStore {
  return new ExportSettingsStore(
    application.config.exportSettingsPath,
    defaultExportSettings(application.config, app.getLocale())
  );
}

function currentYearBounds(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(now.getFullYear(), 0, 1),
    end: new Date(now.getFullYear() + 1, 0, 1)
  };
}

async function bootstrap(application: KakeboApplication): Promise<DesktopBootstrap> {
  const accountRepository = new AccountRepository(application.database);
  const accounts = accountRepository.listEditable();
  if (!existsSync(application.config.accountsConfigPath)) {
    await new AccountsConfigStore(application.config.accountsConfigPath).save(
      accounts
    );
  }
  const rulesStore = new CategorizationRulesStore(
    application.config.categorizationRulesPath
  );
  const categorization = await rulesStore.loadConfiguration();
  const { exclusions, rules } = categorization;
  const categoriesStore = new CategoriesStore(
    application.config.categoriesConfigPath
  );
  let categories = await categoriesStore.load();
  if (!existsSync(application.config.categoriesConfigPath)) {
    const derived = new Map<string, Set<string>>();
    for (const rule of rules) {
      const subcategories = derived.get(rule.category) ?? new Set<string>();
      if (rule.subcategory) subcategories.add(rule.subcategory);
      derived.set(rule.category, subcategories);
    }
    categories = await categoriesStore.save(
      [...derived].map(([name, subcategories]) => ({
        name,
        subcategories: [...subcategories]
      }))
    );
  }
  const exportSettings = await exportSettingsStore(application).ensure();
  const cardImportProfiles = await new CardImportProfilesStore(
    application.config.cardImportProfilesPath
  ).ensure();
  const audit = new DesktopRunRepository(application.database);
  const year = currentYearBounds();
  const auditHistoryLimit =
    localization?.getAuditHistoryLimit() ?? 10;
  return {
    appName: "Kakebo Harvester",
    version: app.getVersion(),
    environment: "production",
    callbackUrl: application.config.redirectUrl,
    callbackReady: callbackServer !== undefined,
    defaultCountry: application.config.defaultCountry,
    defaultPsuType: application.config.defaultPsuType,
    defaultDateFrom: monthsAgoIso(3),
    defaultDateTo: todayIso(),
    connections: connections(application),
    accounts,
    exclusions,
    rules,
    categories,
    exportSettings,
    cardImportProfiles,
    recentRuns: audit.list(auditHistoryLimit),
    auditHistoryLimit,
    runsThisYear: audit.countBetween(year.start, year.end),
    language: localization?.getLanguage() ?? "en",
    translations: localization?.getTranslations() ?? {},
    paths: {
      root: rootDirectory,
      database: application.config.databasePath,
      exportDirectory: application.config.exportDirectory,
      exportFile: exportOutputPath(application.config, exportSettings),
      categorizationRules: application.config.categorizationRulesPath,
      accountsConfig: application.config.accountsConfigPath,
      categoriesConfig: application.config.categoriesConfigPath,
      exportSettings: application.config.exportSettingsPath,
      cardImportProfiles: application.config.cardImportProfilesPath,
      uiSettings: application.config.uiSettingsPath
    },
    scheduledCommand: `"${scheduledExecutable()}" --scheduled-sync`
  };
}

function registerIpc(application: KakeboApplication): void {
  const accountRepository = new AccountRepository(application.database);
  const accountsStore = new AccountsConfigStore(application.config.accountsConfigPath);
  const rulesStore = new CategorizationRulesStore(
    application.config.categorizationRulesPath
  );
  const categoriesStore = new CategoriesStore(
    application.config.categoriesConfigPath
  );
  const exportStore = exportSettingsStore(application);
  const cardProfilesStore = new CardImportProfilesStore(
    application.config.cardImportProfilesPath
  );
  const cardImport = new CardImportService(
    application.config,
    application.database
  );
  const audit = new DesktopRunRepository(application.database);
  const runner = new SyncRunner(
    application.config,
    application.database,
    application.sync
  );

  ipcMain.handle("app:bootstrap", async (event) => {
    assertTrustedSender(event);
    return await bootstrap(application);
  });
  ipcMain.handle("app:confirm-close", (event) => {
    assertTrustedSender(event);
    closeConfirmed = true;
    mainWindow?.close();
  });
  ipcMain.handle("sync:start", async (event, input: unknown) => {
    assertTrustedSender(event);
    const parsedRequest = syncRequestSchema.parse(input);
    const request: SyncRequest = {
      steps: parsedRequest.steps,
      dateFrom: parsedRequest.dateFrom,
      dateTo: parsedRequest.dateTo,
      ...(parsedRequest.allowRateLimitOverride === undefined
        ? {}
        : {
            allowRateLimitOverride:
              parsedRequest.allowRateLimitOverride
          })
    };
    if (activeSync) {
      throw new Error("A synchronization is already running.");
    }
    const run = trackOperation(
      runner.run(request, {
        psuHeaders: {
          userAgent:
            mainWindow?.webContents.getUserAgent() ??
            `Kakebo-Harvester/${app.getVersion()} Electron`,
          acceptLanguage: localization?.getLanguage() ?? app.getLocale()
        },
        allowRateLimitOverride: request.allowRateLimitOverride === true,
        onProgress: (progress: SyncProgressEvent) =>
          sendToRenderer("sync:progress", progress),
        onAccountFailure: requestAccountFailureDecision,
        onReauthorization: async (connectionIds) => {
          if (!callbackServer) {
            throw new Error(
              "Prepare local HTTPS before renewing a bank connection."
            );
          }
          if (!coordinator) {
            throw new Error("Authorization coordinator is unavailable.");
          }
          await coordinator.reauthorize(connectionIds);
        }
      })
    );
    activeSync = run;
    try {
      return await run;
    } finally {
      if (activeSync === run) activeSync = undefined;
    }
  });
  ipcMain.handle("sync:account-failure:resolve", (event, input: unknown) => {
    assertTrustedSender(event);
    const decision = accountFailureDecisionSchema.parse(input);
    if (pendingAccountFailureDecision?.requestId !== decision.requestId) {
      return false;
    }
    return resolvePendingAccountFailureDecision(decision.decision);
  });
  ipcMain.handle("accounts:save", async (event, input: unknown) => {
    assertTrustedSender(event);
    const accounts = z.array(editableAccountSchema).parse(input);
    return await trackOperation(
      saveAccountSettings({
        database: application.database,
        repository: accountRepository,
        store: accountsStore,
        updates: accounts.map((account) => ({
          id: account.id,
          alias: account.alias,
          syncEnabled: account.syncEnabled,
          exportEnabled: account.exportEnabled
        }))
      })
    );
  });
  ipcMain.handle("categorization:save", async (event, input: unknown) => {
    assertTrustedSender(event);
    try {
      return await trackOperation(
        withSynchronizationLock(application, async () =>
          await saveCategorizationSettings(categoriesStore, rulesStore, input)
        )
      );
    } catch (error) {
      if (error instanceof CategorizationReferenceError) {
        throw new Error(
          error.subcategory
            ? trf(
                "error.ruleSubcategory",
                'Rule {number} uses a subcategory that does not belong to "{category}".',
                { number: error.ruleNumber, category: error.category }
              )
            : trf(
                "error.ruleCategory",
                'Rule {number} uses an unknown category: "{category}".',
                { number: error.ruleNumber, category: error.category }
              )
        );
      }
      throw error;
    }
  });
  ipcMain.handle("export-settings:save", async (event, input: unknown) => {
    assertTrustedSender(event);
    return await trackOperation(
      withSynchronizationLock(application, async () =>
        exportStore.save(exportSettingsSchema.parse(input))
      )
    );
  });
  ipcMain.handle("cards:profiles:save", async (event, input: unknown) => {
    assertTrustedSender(event);
    return await trackOperation(
      withSynchronizationLock(application, async () =>
        await cardProfilesStore.save(
          z.array(cardImportProfileSchema).parse(input)
        )
      )
    );
  });
  ipcMain.handle("cards:files:select", async (event) => {
    assertTrustedSender(event);
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: tr("cards.selectDialog", "Select card statements"),
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: tr("cards.xlsxFiles", "Excel workbooks"),
              extensions: ["xlsx"]
            }
          ]
        })
      : await dialog.showOpenDialog({
          title: tr("cards.selectDialog", "Select card statements"),
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: tr("cards.xlsxFiles", "Excel workbooks"),
              extensions: ["xlsx"]
            }
          ]
        });
    return result.canceled
      ? []
      : result.filePaths.map((path) => ({ path, name: basename(path) }));
  });
  ipcMain.handle("cards:import", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (activeSync) {
      throw new Error(
        tr(
          "error.cardsDuringSync",
          "Wait for the synchronization to finish before importing card files."
        )
      );
    }
    const request = cardImportRequestSchema.parse(input);
    return await trackOperation(
      withSynchronizationLock(application, async () => {
        const imported = await cardImport.import(request);
        const exported = await new CsvExporter(
          application.config,
          application.database
        ).export({ highlightSource: "cards" });
        await accountsStore.save(accountRepository.listEditable());
        return { ...imported, exportPath: exported.path };
      })
    );
  });
  ipcMain.handle("language:set", async (event, input: unknown) => {
    assertTrustedSender(event);
    const language: AppLanguage = z.enum(["en", "es"]).parse(input);
    if (!localization) throw new Error("Localization is unavailable.");
    await localization.setLanguage(language);
    return await bootstrap(application);
  });
  ipcMain.handle("audit:limit:set", async (event, input: unknown) => {
    assertApplicationSender(event);
    const limit = auditHistoryLimitSchema.parse(input);
    if (!localization) throw new Error("Localization is unavailable.");
    await localization.setAuditHistoryLimit(limit);
    return audit.list(limit);
  });
  ipcMain.handle("rules:reapply", async (event) => {
    assertTrustedSender(event);
    return await trackOperation(
      withSynchronizationLock(application, async () => {
        const updated = application.sync.recategorizeTransactions();
        const exported = await new CsvExporter(
          application.config,
          application.database
        ).export();
        return { updated, exportPath: exported.path };
      })
    );
  });
  ipcMain.handle("banks:list", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (activeSync) {
      throw new Error(
        tr(
          "error.connectDuringSync",
          "Wait for the synchronization to finish before listing bank connections."
        )
      );
    }
    const { country } = listBanksSchema.parse(input);
    const banks = await trackOperation(
      withSynchronizationLock(application, async () =>
        await application.client.listBanks(country)
      )
    );
    return banks
      .map<BankOption>((bank) => ({
        name: bank.name,
        country: bank.country,
        psuTypes: bank.psu_types,
        authentication: bank.auth_methods
          .map((method) => ({
            psuType: method.psu_type,
            name:
              method.title?.trim() ||
              method.name?.trim() ||
              method.approach
          }))
          .filter((method) => method.name.length > 0)
          .filter(
            (method, index, methods) =>
              methods.findIndex(
                (candidate) =>
                  candidate.psuType === method.psuType &&
                  candidate.name === method.name
              ) === index
          )
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });
  ipcMain.handle("connection:connect", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (activeSync) {
      throw new Error(
        tr(
          "error.connectDuringSync",
          "Wait for the synchronization to finish before connecting a bank."
        )
      );
    }
    if (!callbackServer) {
      throw new Error(
        tr(
          "error.callbackRequired",
          "Prepare local HTTPS before connecting a bank."
        )
      );
    }
    const authorizationCoordinator = coordinator;
    if (!authorizationCoordinator) {
      throw new Error(
        tr(
          "error.authorizationUnavailable",
          "Bank authorization is unavailable. Restart the application and try again."
        )
      );
    }
    const request = connectBankSchema.parse(input);
    await trackOperation(
      withSynchronizationLock(application, async () => {
        await authorizationCoordinator.connect(request);
        await accountsStore.save(accountRepository.listEditable());
      })
    );
  });
  ipcMain.handle("connection:reauthorize", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (activeSync) {
      throw new Error(
        tr(
          "error.reauthorizeDuringSync",
          "Wait for the synchronization to finish before renewing a bank connection."
        )
      );
    }
    const connectionId = z.string().min(1).parse(input);
    if (!callbackServer) {
      throw new Error("Prepare local HTTPS before renewing a bank connection.");
    }
    const authorizationCoordinator = coordinator;
    if (!authorizationCoordinator) {
      throw new Error("Authorization coordinator is unavailable.");
    }
    await trackOperation(
      withSynchronizationLock(application, async () => {
        await authorizationCoordinator.reauthorize([connectionId]);
      })
    );
  });
  ipcMain.handle("connection:disconnect", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (activeSync) {
      throw new Error(
        tr(
          "error.disconnectDuringSync",
          "Wait for the synchronization to finish before revoking a bank connection."
        )
      );
    }
    const connectionId = z.string().min(1).parse(input);
    return await trackOperation(
      withSynchronizationLock(application, async () => {
        const result = await disconnectBankConnection({
          config: application.config,
          database: application.database,
          client: application.client,
          connectionId
        });
        await accountsStore.save(accountRepository.listEditable());
        return result;
      })
    );
  });
  ipcMain.handle("doctor:run", async (event) => {
    assertTrustedSender(event);
    return await trackOperation(
      withSynchronizationLock(application, async () =>
        await runDoctor(application.config, application.client)
      )
    );
  });
  ipcMain.handle("audit:open", async (event) => {
    assertTrustedSender(event);
    await createAuditWindow();
  });
  ipcMain.handle("audit:list", (event) => {
    assertAuditSender(event);
    const limit =
      localization?.getAuditHistoryLimit() ?? 10;
    return {
      runs: audit.list(limit),
      limit,
      language: localization?.getLanguage() ?? "en",
      translations: localization?.getTranslations() ?? {}
    };
  });
  ipcMain.handle("audit:close", (event) => {
    assertAuditSender(event);
    auditWindow?.close();
  });
  ipcMain.handle("audit:clear", async (event) => {
    assertTrustedSender(event);
    if (activeSync) {
      throw new Error(
        tr(
          "error.clearDuringSync",
          "Wait for the synchronization to finish before clearing history."
        )
      );
    }
    const deleted = await trackOperation(
      withSynchronizationLock(application, () => audit.clear())
    );
    auditWindow?.webContents.send("audit:history-changed");
    return deleted;
  });
  ipcMain.handle("exports:clear", async (event) => {
    assertTrustedSender(event);
    if (activeSync) {
      throw new Error(
        tr(
          "error.clearDuringSync",
          "Wait for the synchronization to finish before deleting result files."
        )
      );
    }
    const result = await trackOperation(
      withSynchronizationLock(application, async () =>
        resetLocalData(application.config, application.database)
      )
    );
    auditWindow?.webContents.send("audit:history-changed");
    return result;
  });
  ipcMain.handle("path:open", async (event, input: unknown) => {
    assertTrustedSender(event);
    const target: OpenPathTarget = openPathTargetSchema.parse(input);
    const data = await bootstrap(application);
    const requiresPreparation = [
      "accounts-config",
      "categorization-rules",
      "categories-config",
      "export-settings",
      "card-import-profiles"
    ].includes(target);
    if (requiresPreparation) {
      await trackOperation(
        withSynchronizationLock(application, async () => {
          if (target === "accounts-config") {
            await accountsStore.save(accountRepository.listEditable());
          }
          if (
            target === "categorization-rules" &&
            !existsSync(data.paths.categorizationRules)
          ) {
            await rulesStore.saveConfiguration({ exclusions: [], rules: [] });
          }
          if (
            target === "categories-config" &&
            !existsSync(data.paths.categoriesConfig)
          ) {
            await categoriesStore.save([]);
          }
          if (
            target === "export-settings" &&
            !existsSync(data.paths.exportSettings)
          ) {
            await exportStore.save(data.exportSettings);
          }
          if (
            target === "card-import-profiles" &&
            !existsSync(data.paths.cardImportProfiles)
          ) {
            await cardProfilesStore.save(data.cardImportProfiles);
          }
        })
      );
    }
    const paths: Record<OpenPathTarget, string> = {
      root: data.paths.root,
      "export-directory": data.paths.exportDirectory,
      "export-file": data.paths.exportFile,
      "categorization-rules": data.paths.categorizationRules,
      "accounts-config": data.paths.accountsConfig,
      "categories-config": data.paths.categoriesConfig,
      "export-settings": data.paths.exportSettings,
      "card-import-profiles": data.paths.cardImportProfiles,
      "ui-settings": data.paths.uiSettings
    };
    const error = await shell.openPath(paths[target]);
    if (error) throw new Error(error);
  });
  ipcMain.handle("clipboard:write", (event, input: unknown) => {
    assertTrustedSender(event);
    clipboard.writeText(z.string().max(8_000).parse(input));
  });
  ipcMain.handle("https:setup", async (event) => {
    assertTrustedSender(event);
    if (!application.config.tlsPfxPath) {
      throw new Error("APP_TLS_PFX_PATH is not configured.");
    }
    const options = {
      type: "warning" as const,
      title: "Kakebo Harvester",
      message: tr(
        "dialog.regenerateHttps.message",
        "Regenerate the local HTTPS certificate?"
      ),
      detail: tr(
        "dialog.regenerateHttps.detail",
        "Use this on a new computer or when the certificate is no longer valid. The current certificate is replaced for this Windows user."
      ),
      buttons: [
        tr("common.cancel", "Cancel"),
        tr("dialog.regenerateHttps.confirm", "Regenerate")
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 1) return false;

    return await trackOperation(
      withSynchronizationLock(application, async () => {
        await callbackServer?.close();
        callbackServer = undefined;
        let setupError: unknown;
        try {
          await generateLocalHttps(application, true);
        } catch (error) {
          setupError = error;
        }
        try {
          callbackServer = await listenForCallbacks(application);
        } catch (error) {
          if (!setupError) setupError = error;
        }
        if (setupError) {
          throw setupError instanceof Error
            ? setupError
            : new Error(safeMessage(setupError));
        }
        return true;
      })
    );
  });
}

async function createAuditWindow(): Promise<void> {
  if (auditWindow && !auditWindow.isDestroyed()) {
    auditWindow.show();
    auditWindow.focus();
    return;
  }
  const preloadPath = join(
    app.getAppPath(),
    "dist",
    "src",
    "desktop",
    "audit-preload.cjs"
  );
  const rendererPath = join(
    app.getAppPath(),
    "dist",
    "src",
    "desktop",
    "audit.html"
  );
  auditWindow = new BrowserWindow({
    width: 1134,
    height: 819,
    minWidth: 907,
    minHeight: 630,
    ...(mainWindow ? { parent: mainWindow } : {}),
    show: false,
    backgroundColor: "#f4f0e7",
    title: tr("audit.windowTitle", "Execution history · Kakebo Harvester"),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      zoomFactor: UI_ZOOM_FACTOR
    }
  });
  auditWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  auditWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  auditWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  );
  auditWindow.once("ready-to-show", () => auditWindow?.show());
  await auditWindow.loadFile(rendererPath);
  if (!auditWindow.isDestroyed() && !auditWindow.isVisible()) {
    auditWindow.show();
  }
  auditWindow.webContents.setZoomFactor(UI_ZOOM_FACTOR);
  auditWindow.on("closed", () => {
    auditWindow = undefined;
  });
}

async function createLoadingWindow(): Promise<void> {
  const rendererPath = join(
    app.getAppPath(),
    "dist",
    "src",
    "desktop",
    "loading.html"
  );
  loadingWindow = new BrowserWindow({
    width: 560,
    height: 220,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    frame: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: "#fffdf8",
    title: "Kakebo Harvester",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  loadingWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  loadingWindow.webContents.on("will-navigate", (event) =>
    event.preventDefault()
  );
  loadingWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  );
  await loadingWindow.loadFile(rendererPath);
  loadingWindow.show();
  loadingWindow.on("closed", () => {
    loadingWindow = undefined;
  });
}

async function createWindow(): Promise<void> {
  const preloadPath = join(app.getAppPath(), "dist", "src", "desktop", "preload.cjs");
  const rendererPath = join(app.getAppPath(), "dist", "src", "desktop", "index.html");
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1271,
    height: 794,
    minWidth: 958,
    minHeight: 655,
    show: false,
    backgroundColor: "#f4f0e7",
    title: "Kakebo Harvester",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      zoomFactor: UI_ZOOM_FACTOR
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  );
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadFile(rendererPath);
  if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
  }
  loadingWindow?.destroy();
  loadingWindow = undefined;
  mainWindow.webContents.setZoomFactor(UI_ZOOM_FACTOR);
  mainWindow.on("closed", () => {
    resolvePendingAccountFailureDecision("stop");
    mainWindow = undefined;
  });
  mainWindow.on("close", (event) => {
    if (closeConfirmed || quitting) return;
    event.preventDefault();
    mainWindow?.webContents.send("app:close-requested");
  });
}

async function runScheduled(): Promise<void> {
  let application: KakeboApplication | undefined;
  let exitCode = 0;
  try {
    environmentFile = findEnvironmentFile();
    rootDirectory = dirname(environmentFile);
    process.chdir(rootDirectory);
    application = createKakeboApplication(environmentFile, {
      overrideEnvironment: true
    });
    if (application.config.appEnv !== "production") {
      throw new Error("Scheduled desktop synchronization only supports production.");
    }
    const window = getSyncWindow(application.config.syncLookbackDays);
    await new SyncRunner(
      application.config,
      application.database,
      application.sync
    ).run({
      steps: ["accounts", "balances", "transactions", "export"],
      dateFrom: window.dateFrom,
      dateTo: window.dateTo
    });
  } catch (error) {
    console.error(`Error: ${safeMessage(error)}`);
    exitCode = error instanceof KakeboError ? error.exitCode : 1;
  } finally {
    application?.close();
  }
  app.exit(exitCode);
}

async function runDesktop(): Promise<void> {
  await createLoadingWindow();
  environmentFile = findEnvironmentFile();
  rootDirectory = dirname(environmentFile);
  process.chdir(rootDirectory);
  domainApplication = createKakeboApplication(environmentFile, {
    overrideEnvironment: true
  });
  if (domainApplication.config.appEnv !== "production") {
    throw new Error("The desktop application only supports production.");
  }
  localization = new LocalizationStore(
    domainApplication.config.uiSettingsPath,
    join(app.getAppPath(), "dist", "src", "desktop", "locales"),
    app.getLocale()
  );
  await localization.initialize();
  coordinator = new AuthorizationCoordinator(domainApplication, (result) =>
    sendToRenderer("authorization:result", result)
  );
  let callbackStartupError: unknown;
  try {
    const httpsReady = await ensureLocalHttps(domainApplication);
    if (httpsReady) {
      callbackServer = await listenForCallbacks(domainApplication);
    } else {
      callbackStartupError = new Error(
        "Local HTTPS has not been prepared on this computer."
      );
    }
  } catch (error) {
    callbackStartupError = error;
  }
  registerIpc(domainApplication);
  await createWindow();
  if (callbackStartupError) {
    const detail = safeMessage(callbackStartupError);
    const options = {
      type: "warning" as const,
      title: "Kakebo Harvester",
      message: tr(
        "dialog.httpsUnavailable.message",
        "The local HTTPS server is unavailable."
      ),
      detail: `${detail}\n\n${tr(
        "dialog.httpsUnavailable.detail",
        "Repair it from Settings > Prepare HTTPS on this computer."
      )}`,
      buttons: [tr("common.understood", "Understood")],
      defaultId: 0,
      noLink: true
    };
    if (mainWindow) {
      await dialog.showMessageBox(mainWindow, options);
    } else {
      await dialog.showMessageBox(options);
    }
  }
}

app.setName("Kakebo Harvester");
const scheduledMode = desktopArguments().includes("--scheduled-sync");
const ownsInstanceLock = scheduledMode || app.requestSingleInstanceLock();
if (!ownsInstanceLock) app.quit();

void app
  .whenReady()
  .then(async () => {
    if (!ownsInstanceLock) return;
    if (scheduledMode) {
      await runScheduled();
      return;
    }
    try {
      await runDesktop();
    } catch (error) {
      loadingWindow?.destroy();
      loadingWindow = undefined;
      dialog.showErrorBox("Kakebo Harvester", safeMessage(error));
      app.quit();
    }
  })
  .catch((error: unknown) => {
    dialog.showErrorBox("Kakebo Harvester", safeMessage(error));
    app.quit();
  });

app.on("activate", () => {
  if (!mainWindow && domainApplication && !quitting) void createWindow();
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    loadingWindow?.show();
    loadingWindow?.focus();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  quitting = true;
  mainWindow?.hide();
  auditWindow?.hide();
  loadingWindow?.hide();
  resolvePendingAccountFailureDecision("stop");
  coordinator?.cancelAll("The application is closing.");
  shutdownPromise ??= (async () => {
    await Promise.allSettled([...activeOperations]);
    await callbackServer?.close();
    callbackServer = undefined;
    domainApplication?.close();
    domainApplication = undefined;
    cleanupComplete = true;
    app.quit();
  })();
});
