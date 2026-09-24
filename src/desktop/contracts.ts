import type { DoctorCheck } from "../doctor.js";
import type { PsuType } from "../config.js";
import type { CardImportRequest } from "../cards/card-import-service.js";
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
import type {
  CardImportOperationResult,
  ConnectionOperationResult,
  DisconnectOperationResult,
  FollowUpWarning,
  RecategorizationOperationResult
} from "./committed-operations.js";

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
  lastCompletedRunAt: string | null;
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
    cardsConfig: string;
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

export interface KutxabankInspection {
  cards: Array<{ selectionToken: string; last4: string; alias?: string;
    balance?: { text: string; isRed: boolean } }>;
  connections: Array<{ id: string; alias: string;
    cards: Array<{ id: string; alias: string; last4: string | null }> }>;
}

export interface KutxabankCatalogConnection {
  id: string;
  alias: string;
  cards: Array<{ id: string; connectionId: string; alias: string; last4: string; syncEnabled: boolean;
    balance: { text: string; isRed: boolean; readAt: string } | null }>;
}

export interface KutxabankSyncInput {
  selectionToken: string;
  connectionId?: string;
  connectionAlias?: string;
  accountId?: string;
  accountAlias?: string;
  dateFrom: string;
  dateTo: string;
  period?: import("./kutxabank-period.js").KutxabankPeriod;
}

export interface KutxabankSyncResult {
  rows: number;
  inserted: number;
  updated: number;
  duplicates: number;
  reconciled: number;
  exportPath: string | null;
  warnings: FollowUpWarning[];
  cardWarnings?: Array<{ accountId: string; code: string }>;
}

export interface ReconciliationMovement {
  movementKey: string;
  date: string | null;
  account: string;
  source: string;
  description: string;
  amount: string;
  currency: string;
  status: string;
  reference: string | null;
}

export interface ReconciliationList {
  movements: ReconciliationMovement[];
  truncated: boolean;
}

export interface ReconciliationOperationResult {
  reference?: string;
  exportPath: string | null;
  warnings: FollowUpWarning[];
}

export interface KakeboDesktopApi {
  openKutxabank: () => Promise<void>;
  inspectKutxabank: () => Promise<KutxabankInspection>;
  listKutxabankCatalog: () => Promise<KutxabankCatalogConnection[]>;
  saveKutxabankCatalog: () => Promise<{
    connections: KutxabankCatalogConnection[]; warnings: FollowUpWarning[] }>;
  onKutxabankCatalogUpdated: (listener: (result: {
    connections: KutxabankCatalogConnection[]; warnings: FollowUpWarning[]
  }) => void) => () => void;
  onKutxabankCatalogError: (listener: (code: string) => void) => () => void;
  setKutxabankCardSyncEnabled: (input: { connectionId: string; accountId: string; enabled: boolean }) => Promise<{
    connections: KutxabankCatalogConnection[]; warnings: FollowUpWarning[] }>;
  setKutxabankCardAlias: (input: { connectionId: string; accountId: string; alias: string }) => Promise<{
    connections: KutxabankCatalogConnection[]; warnings: FollowUpWarning[] }>;
  deleteKutxabankCard: (input: { connectionId: string; accountId: string }) => Promise<{
    connections: KutxabankCatalogConnection[]; warnings: FollowUpWarning[] }>;
  syncKutxabankCatalog: (input: { dateFrom: string; dateTo: string;
    period: import("./kutxabank-period.js").KutxabankPeriod }) => Promise<KutxabankSyncResult>;
  syncKutxabank: (input: KutxabankSyncInput) => Promise<KutxabankSyncResult>;
  forgetKutxabankDevice: () => Promise<boolean>;
  disconnectKutxabank: (connectionId: string) => Promise<ConnectionOperationResult>;
  listReconciliation: (input: { dateFrom: string; dateTo: string }) => Promise<ReconciliationList>;
  confirmReconciliation: (input: { firstKey: string; secondKey: string; kind: "settlement" | "duplicate" }) => Promise<ReconciliationOperationResult>;
  undoReconciliation: (reference: string) => Promise<ReconciliationOperationResult>;
  bootstrap: () => Promise<DesktopBootstrap>;
  startSync: (request: SyncRequest) => Promise<SyncRunResult>;
  resolveAccountFailure: (input: {
    requestId: string;
    decision: "continue" | "stop";
  }) => Promise<boolean>;
  saveAccounts: (accounts: EditableAccount[]) => Promise<EditableAccount[]>;
  saveCategorization: (input: {
    categories: CategoryDefinition[];
    exclusions: CategorizationConfiguration["exclusions"];
    rules: CategorizationConfiguration["rules"];
  }) => Promise<{
    categories: CategoryDefinition[];
    exclusions: CategorizationConfiguration["exclusions"];
    rules: CategorizationConfiguration["rules"];
  }>;
  saveExportSettings: (settings: ExportSettings) => Promise<ExportSettings>;
  saveCardImportProfiles: (
    profiles: CardImportProfile[]
  ) => Promise<CardImportProfile[]>;
  selectCardFiles: () => Promise<SelectedCardFile[]>;
  importCardFiles: (
    request: CardImportRequest
  ) => Promise<CardImportOperationResult>;
  setLanguage: (language: AppLanguage) => Promise<DesktopBootstrap>;
  setAuditHistoryLimit: (
    limit: AuditHistoryLimit
  ) => Promise<AuditRunView[]>;
  reapplyRules: () => Promise<RecategorizationOperationResult>;
  listBanks: (country: string) => Promise<BankOption[]>;
  connectBank: (
    request: ConnectBankRequest
  ) => Promise<ConnectionOperationResult>;
  reauthorize: (connectionId: string) => Promise<ConnectionOperationResult>;
  disconnectBank: (
    connectionId: string
  ) => Promise<DisconnectOperationResult>;
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
