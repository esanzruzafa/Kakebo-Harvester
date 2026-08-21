import type { AppEnvironment } from "../config.js";
import type { ProviderTransaction } from "../enable-banking/schemas.js";
import type { StoredAccount } from "../storage/repositories/account-repository.js";
import { stableJson, sha256 } from "../utils/crypto.js";
import { maskIdentifier, normalizeText } from "../utils/text.js";
import { createMovementKey, createReconciliationKey } from "./movement-key.js";

export interface NormalizedTransaction {
  movement_key: string;
  reconciliation_key: string;
  provider: string;
  environment: AppEnvironment;
  bank_connection_id: string;
  account_id: string;
  provider_transaction_id: string | null;
  entry_reference: string | null;
  fallback_occurrence: number | null;
  status: string;
  booking_date: string | null;
  value_date: string | null;
  transaction_datetime: string | null;
  amount: string;
  currency: string;
  direction: string;
  description_raw: string | null;
  description_normalized: string;
  merchant_name: string | null;
  creditor_name: string | null;
  debtor_name: string | null;
  counterparty_iban_masked: string | null;
  bank_transaction_code: string | null;
  merchant_category_code: string | null;
  balance_after: string | null;
  category_auto: string | null;
  subcategory_auto: string | null;
  source_raw_file: string | null;
  raw_fingerprint: string;
}

export function normalizeDecimal(
  value: string,
  indicator?: string | null
): { amount: string; direction: string } {
  const trimmed = value.trim().replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [wholePart = "0", fractionalPart] = unsigned.split(".");
  const normalizedWhole = wholePart.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fractionalPart?.replace(/0+$/, "");
  const normalizedUnsigned = normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
  const isDebit = indicator === "DBIT" || (!indicator && trimmed.startsWith("-"));
  const isZero = normalizedUnsigned === "0";
  return {
    amount: isDebit && !isZero ? `-${normalizedUnsigned}` : normalizedUnsigned,
    direction: isDebit ? "expense" : "income"
  };
}

function transactionStatus(status: string | null | undefined): string {
  if (status === "BOOK") return "booked";
  if (["PDNG", "HOLD", "SCHD"].includes(status ?? "")) return "pending";
  return (status ?? "unknown").toLowerCase();
}

function accountIdentifier(
  account: ProviderTransaction["creditor_account"] | null | undefined
): string | null {
  if (account?.iban) return account.iban;
  if (
    typeof account?.other === "object" &&
    account.other !== null &&
    "identification" in account.other &&
    typeof account.other.identification === "string"
  ) {
    return account.other.identification;
  }
  return typeof account?.other === "string" ? account.other : null;
}

export function mapTransaction(input: {
  transaction: ProviderTransaction;
  account: StoredAccount;
  environment: AppEnvironment;
  rawPath: string | null;
  fallbackOccurrence?: number | undefined;
}): NormalizedTransaction {
  const transaction = input.transaction;
  const money = normalizeDecimal(
    transaction.transaction_amount.amount,
    transaction.credit_debit_indicator
  );
  const status = transactionStatus(transaction.status);
  const remittance = Array.isArray(transaction.remittance_information)
    ? transaction.remittance_information.join(" ")
    : transaction.remittance_information;
  const description =
    remittance ??
    transaction.note ??
    transaction.bank_transaction_code?.description ??
    transaction.creditor?.name ??
    transaction.debtor?.name ??
    "";
  const descriptionNormalized = normalizeText(description);
  const counterpartyName =
    money.direction === "expense" ? transaction.creditor?.name : transaction.debtor?.name;
  const counterpartyAccount =
    money.direction === "expense"
      ? accountIdentifier(transaction.creditor_account)
      : accountIdentifier(transaction.debtor_account);
  const counterparty = normalizeText(counterpartyName ?? counterpartyAccount ?? "");
  const accountStableKey = input.account.identification_hash ?? input.account.id;
  const entryReference = transaction.entry_reference?.trim() || null;
  const providerTransactionId = transaction.transaction_id?.trim() || null;
  const keyInput = {
    accountStableKey,
    status,
    entryReference,
    providerTransactionId,
    bookingDate: transaction.booking_date,
    valueDate: transaction.value_date,
    amount: money.amount,
    currency: transaction.transaction_amount.currency,
    descriptionNormalized,
    counterparty,
    fallbackOccurrence: input.fallbackOccurrence
  };
  const bankCode = [
    transaction.bank_transaction_code?.code,
    transaction.bank_transaction_code?.sub_code
  ]
    .filter(Boolean)
    .join(".");

  return {
    movement_key: createMovementKey(keyInput),
    reconciliation_key: createReconciliationKey(keyInput),
    provider: "enable-banking",
    environment: input.environment,
    bank_connection_id: input.account.bank_connection_id,
    account_id: input.account.id,
    provider_transaction_id: providerTransactionId,
    entry_reference: entryReference,
    fallback_occurrence:
      entryReference || providerTransactionId ? null : (input.fallbackOccurrence ?? 1),
    status,
    booking_date: transaction.booking_date ?? null,
    value_date: transaction.value_date ?? null,
    transaction_datetime: transaction.transaction_date ?? null,
    amount: money.amount,
    currency: transaction.transaction_amount.currency,
    direction: money.direction,
    description_raw: description || null,
    description_normalized: descriptionNormalized,
    merchant_name: counterpartyName ?? null,
    creditor_name: transaction.creditor?.name ?? null,
    debtor_name: transaction.debtor?.name ?? null,
    counterparty_iban_masked: maskIdentifier(counterpartyAccount),
    bank_transaction_code: bankCode || null,
    merchant_category_code: transaction.merchant_category_code ?? null,
    balance_after: transaction.balance_after_transaction?.amount ?? null,
    category_auto: null,
    subcategory_auto: null,
    source_raw_file: input.rawPath,
    raw_fingerprint: sha256(stableJson(transaction))
  };
}
