import type { DoctorCheck } from "../doctor.js";
import type { PsuType } from "../config.js";
import type { DisconnectResult } from "../auth/disconnect-service.js";
import type {
  CardImportRequest,
  CardImportResult
} from "../cards/card-import-service.js";
import type { CardImportProfile } from "../settings/card-import-profiles-store.js";
import type { CategoryDefinition } from "../settings/categories-store.js";
import type {
  CategorizationConfiguration,
  CategorizationExclusion,
  CategorizationRule
} from "../settings/categorization-rules-store.js";
import type { ExportSettings } from "../settings/export-settings-store.js";
import type {
  AppLanguage,
  AuditHistoryLimit,
  TranslationDictionary
} from "../settings/localization-store.js";
import type { EditableAccount } from "../storage/repositories/account-repository.js";
import type { AuditRunView } from "../storage/repositories/desktop-run-repository.js";
import type { LocalDataResetResult } from "../storage/local-data-reset.js";
import type { AccountSyncFailure } from "../sync/sync-service.js";
import type {
  SyncProgressEvent,
  SyncRequest,
  SyncRunResult
} from "../sync/sync-runner.js";

export interface ConnectionView {
  id: string;
  bank: string;
  alias: string;
  status: string;
  validUntil: string | null;
  lastSyncAt: string | null;
  reauthorizationRequired: boolean;
  retryAfterAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  onlineRetryUsed: boolean;
}

export interface BankOption {
  name: string;
  country: string;
  psuTypes: PsuType[];
  authentication: Array<{
    psuType: PsuType;
    name: string;
  }>;
}

export interface ConnectBankRequest {
  bankName: string;
  country: string;
  psuType: PsuType;
}

export interface DesktopBootstrap {
  appName: string;
  version: string;
  environment: "production";
  callbackUrl: string;
  callbackReady: boolean;
  defaultCountry: string;
  defaultPsuType: PsuType;
  defaultDateFrom: string;
  defaultDateTo: string;
  connections: ConnectionView[];
  accounts: EditableAccount[];
  exclusions: CategorizationExclusion[];
  rules: CategorizationRule[];
  categories: CategoryDefinition[];
  exportSettings: ExportSettings;
  cardImportProfiles: CardImportProfile[];
  recentRuns: AuditRunView[];
  auditHistoryLimit: AuditHistoryLimit;
  runsThisYear: number;
  language: AppLanguage;
  translations: TranslationDictionary;
  paths: {
    root: string;
    database: string;
    exportDirectory: string;
    exportFile: string;
    categorizationRules: string;
    accountsConfig: string;
    categoriesConfig: string;
    exportSettings: string;
    cardImportProfiles: string;
    uiSettings: string;
  };
  scheduledCommand: string;
}

export interface AuthorizationUiResult {
  connectionId: string;
  status: "authorized" | "denied" | "failed";
  bankName: string;
  message?: string;
}

export interface AccountFailurePrompt extends AccountSyncFailure {
  requestId: string;
}

export type OpenPathTarget =
  | "root"
  | "export-directory"
  | "export-file"
  | "categorization-rules"
  | "accounts-config"
  | "categories-config"
  | "export-settings"
  | "card-import-profiles"
  | "ui-settings";

export interface SelectedCardFile {
  path: string;
  name: string;
}

export interface CardImportUiResult extends CardImportResult {
  exportPath: string;
}

export interface KakeboDesktopApi {
  bootstrap: () => Promise<DesktopBootstrap>;
  startSync: (request: SyncRequest) => Promise<SyncRunResult>;
  resolveAccountFailure: (input: {
    requestId: string;
    decision: "continue" | "stop";
  }) => Promise<boolean>;
  saveAccounts: (accounts: EditableAccount[]) => Promise<EditableAccount[]>;
  saveRules: (
    configuration: CategorizationConfiguration
  ) => Promise<CategorizationConfiguration>;
  saveCategories: (
    categories: CategoryDefinition[]
  ) => Promise<CategoryDefinition[]>;
  saveExportSettings: (settings: ExportSettings) => Promise<ExportSettings>;
  saveCardImportProfiles: (
    profiles: CardImportProfile[]
  ) => Promise<CardImportProfile[]>;
  selectCardFiles: () => Promise<SelectedCardFile[]>;
  importCardFiles: (request: CardImportRequest) => Promise<CardImportUiResult>;
  setLanguage: (language: AppLanguage) => Promise<DesktopBootstrap>;
  setAuditHistoryLimit: (
    limit: AuditHistoryLimit
  ) => Promise<AuditRunView[]>;
  reapplyRules: () => Promise<{ updated: number; exportPath: string }>;
  listBanks: (country: string) => Promise<BankOption[]>;
  connectBank: (request: ConnectBankRequest) => Promise<void>;
  reauthorize: (connectionId: string) => Promise<void>;
  disconnectBank: (connectionId: string) => Promise<DisconnectResult>;
  runDoctor: () => Promise<DoctorCheck[]>;
  openAuditHistory: () => Promise<void>;
  clearAuditHistory: () => Promise<number>;
  clearExportFiles: () => Promise<LocalDataResetResult>;
  openPath: (target: OpenPathTarget) => Promise<void>;
  copyText: (value: string) => Promise<void>;
  setupLocalHttps: () => Promise<boolean>;
  confirmClose: () => Promise<void>;
  onCloseRequested: (listener: () => void) => () => void;
  onSyncProgress: (listener: (event: SyncProgressEvent) => void) => () => void;
  onAccountFailure: (listener: (failure: AccountFailurePrompt) => void) => () => void;
  onAuthorizationResult: (
    listener: (event: AuthorizationUiResult) => void
  ) => () => void;
}

export interface AuditWindowApi {
  listHistory: () => Promise<{
    runs: AuditRunView[];
    limit: AuditHistoryLimit;
    language: AppLanguage;
    translations: TranslationDictionary;
  }>;
  setHistoryLimit: (limit: AuditHistoryLimit) => Promise<AuditRunView[]>;
  close: () => Promise<void>;
  onHistoryChanged: (listener: () => void) => () => void;
}

declare global {
  interface Window {
    kakebo: KakeboDesktopApi;
    kakeboAudit?: AuditWindowApi;
  }
}
