import type {
  CardImportResult
} from "../cards/card-import-service.js";
import type { DisconnectResult } from "../auth/disconnect-service.js";
import { safeMessage } from "../utils/text.js";

export type FollowUpStep = "export" | "accounts-config" | "cards-config" | "audit";

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

async function followUp<T>(
  step: FollowUpStep,
  task: () => Promise<T> | T
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
  return await runMovementImportOperation({
    ingest: input.importCards,
    exportMovements: input.exportCards,
    saveAccounts: input.saveAccounts
  });
}

export async function runMovementImportOperation<Result>(input: {
  ingest: () => Promise<Result> | Result;
  exportMovements: () => Promise<{ path: string }>;
  saveAccounts: () => Promise<void>;
  finishAudit?: (hasWarnings: boolean) => void | Promise<void>;
}): Promise<Result & { exportPath: string | null; warnings: FollowUpWarning[] }> {
  const imported = await input.ingest();
  const [exported, accounts] = await Promise.all([
    followUp("export", input.exportMovements),
    followUp("accounts-config", input.saveAccounts)
  ]);
  const warnings = [exported.warning, accounts.warning].filter(
      (warning): warning is FollowUpWarning => warning !== null
    );
  if (input.finishAudit) {
    const finished = await followUp("audit", () => input.finishAudit?.(warnings.length > 0));
    if (finished.warning) warnings.push({ step: "audit", message: "AUDIT_FINALIZATION_FAILED" });
  }
  return {
    ...imported,
    exportPath: exported.value?.path ?? null,
    warnings
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
  connect: () => Promise<void> | void;
  saveAccounts: () => Promise<void>;
  configurationStep?: "accounts-config" | "cards-config";
}): Promise<ConnectionOperationResult> {
  await input.connect();
  const accounts = await followUp(input.configurationStep ?? "accounts-config", input.saveAccounts);
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
