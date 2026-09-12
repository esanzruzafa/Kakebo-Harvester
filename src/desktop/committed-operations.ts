import type {
  CardImportResult
} from "../cards/card-import-service.js";
import type { DisconnectResult } from "../auth/disconnect-service.js";
import { safeMessage } from "../utils/text.js";
import type { AccountRemovalResult } from "../storage/account-removal.js";

export type FollowUpStep = "export" | "accounts-config" | "bootstrap-refresh";

export interface FollowUpWarning {
  step: FollowUpStep;
  message: string;
}

export interface CardImportOperationResult extends CardImportResult {
  exportPath: string | null;
  warnings: FollowUpWarning[];
}

export interface RecategorizationOperationResult {
  updated: number;
  exportPath: string | null;
  warnings: FollowUpWarning[];
}

export interface ConnectionOperationResult {
  warnings: FollowUpWarning[];
}

export interface DisconnectOperationResult extends DisconnectResult {
  warnings: FollowUpWarning[];
}

export interface AccountRemovalOperationResult extends AccountRemovalResult {
  exportPath: string | null;
  warnings: FollowUpWarning[];
}

async function followUp<T>(
  step: FollowUpStep,
  task: () => Promise<T>
): Promise<{ value: T | null; warning: FollowUpWarning | null }> {
  try {
    return { value: await task(), warning: null };
  } catch (error) {
    return {
      value: null,
      warning: { step, message: safeMessage(error) }
    };
  }
}

export async function runCardImportOperation(input: {
  importCards: () => Promise<CardImportResult>;
  exportCards: () => Promise<{ path: string }>;
  saveAccounts: () => Promise<void>;
}): Promise<CardImportOperationResult> {
  const imported = await input.importCards();
  const [exported, accounts] = await Promise.all([
    followUp("export", input.exportCards),
    followUp("accounts-config", input.saveAccounts)
  ]);
  return {
    ...imported,
    exportPath: exported.value?.path ?? null,
    warnings: [exported.warning, accounts.warning].filter(
      (warning): warning is FollowUpWarning => warning !== null
    )
  };
}

export async function runRecategorizationOperation(input: {
  recategorize: () => number;
  exportTransactions: () => Promise<{ path: string }>;
}): Promise<RecategorizationOperationResult> {
  const updated = input.recategorize();
  const exported = await followUp("export", input.exportTransactions);
  return {
    updated,
    exportPath: exported.value?.path ?? null,
    warnings: exported.warning ? [exported.warning] : []
  };
}

export async function runConnectionOperation(input: {
  connect: () => Promise<void>;
  saveAccounts: () => Promise<void>;
}): Promise<ConnectionOperationResult> {
  await input.connect();
  const accounts = await followUp("accounts-config", input.saveAccounts);
  return { warnings: accounts.warning ? [accounts.warning] : [] };
}

export async function runDisconnectOperation(input: {
  disconnect: () => Promise<DisconnectResult>;
  saveAccounts: () => Promise<void>;
}): Promise<DisconnectOperationResult> {
  const disconnected = await input.disconnect();
  const accounts = await followUp("accounts-config", input.saveAccounts);
  return {
    ...disconnected,
    warnings: accounts.warning ? [accounts.warning] : []
  };
}

export async function runAccountRemovalOperation(input: {
  remove: () => Promise<AccountRemovalResult>;
  regenerateExport: () => Promise<{ path: string }>;
  saveAccounts: () => Promise<void>;
}): Promise<AccountRemovalOperationResult> {
  const removed = await input.remove();
  const [exported, accounts] = await Promise.all([
    removed.status === "deleted"
      ? followUp("export", input.regenerateExport)
      : Promise.resolve({ value: null, warning: null }),
    followUp("accounts-config", input.saveAccounts)
  ]);
  return {
    ...removed,
    exportPath: exported.value?.path ?? null,
    warnings: [exported.warning, accounts.warning].filter(
      (warning): warning is FollowUpWarning => warning !== null
    )
  };
}
