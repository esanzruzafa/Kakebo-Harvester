import { sha256 } from "../utils/crypto.js";

export interface MovementKeyInput {
  accountStableKey: string;
  status: string;
  entryReference?: string | null | undefined;
  providerTransactionId?: string | null | undefined;
  bookingDate?: string | null | undefined;
  valueDate?: string | null | undefined;
  amount: string;
  currency: string;
  descriptionNormalized: string;
  counterparty: string;
}

export function createMovementKey(input: MovementKeyInput): string {
  if (input.entryReference) {
    return sha256(`entry|${input.accountStableKey}|${input.entryReference}`);
  }
  if (input.providerTransactionId) {
    return sha256(`provider|${input.accountStableKey}|${input.providerTransactionId}`);
  }
  return sha256(
    [
      "fallback",
      input.accountStableKey,
      input.status,
      input.bookingDate ?? "",
      input.valueDate ?? "",
      input.amount,
      input.currency,
      input.descriptionNormalized,
      input.counterparty
    ].join("|")
  );
}

export function createReconciliationKey(input: MovementKeyInput): string {
  return sha256(
    [
      "reconcile",
      input.accountStableKey,
      input.amount,
      input.currency,
      input.descriptionNormalized,
      input.counterparty
    ].join("|")
  );
}
