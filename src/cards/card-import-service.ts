import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { readSheet } from "read-excel-file/node";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import {
  CardImportProfilesStore,
  type CardImportProfile
} from "../settings/card-import-profiles-store.js";
import type { SqliteDatabase } from "../storage/database.js";
import { Categorizer } from "../transactions/categorization.js";
import { TransactionRepository } from "../transactions/deduplication.js";
import { createMovementKey, createReconciliationKey } from "../transactions/movement-key.js";
import type { NormalizedTransaction } from "../transactions/transaction-mapper.js";
import { normalizeDecimal } from "../transactions/transaction-mapper.js";
import { sha256, stableJson } from "../utils/crypto.js";
import { normalizeText } from "../utils/text.js";

const MAX_CARD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CARD_ROWS = 100_000;

export const cardImportRequestSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        profileId: z.string().min(1)
      })
    )
    .min(1)
    .max(50)
});

export type CardImportRequest = z.output<typeof cardImportRequestSchema>;

export interface CardImportFileResult {
  path: string;
  profileId: string;
  rows: number;
  inserted: number;
  updated: number;
  duplicates: number;
  reconciled: number;
}

export interface CardImportResult {
  files: CardImportFileResult[];
  rows: number;
  inserted: number;
  updated: number;
  duplicates: number;
  reconciled: number;
}

interface ParsedCardRow {
  profile: CardImportProfile;
  sourcePath: string;
  sourceRow: number;
  bookingDate: string;
  valueDate: string | null;
  description: string;
  amount: string;
  direction: string;
  occurrence: number;
  statementKey: string;
}

interface ExistingCardTransaction {
  providerTransactionId: string;
  sourcePath: string | null;
}

interface SourceRowMapping {
  providerTransactionId: string;
  sourceRow: number | null;
}

function cardSemanticKey(row: ParsedCardRow): string {
  return stableJson({
    profileId: row.profile.id,
    bookingDate: row.bookingDate,
    valueDate: row.valueDate,
    description: normalizeText(row.description),
    amount: row.amount,
    currency: row.profile.currency
  });
}

function cardSemanticKeyHash(row: ParsedCardRow): string {
  return sha256(cardSemanticKey(row));
}

function comparableSourcePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sourcePathHash(path: string): string {
  return sha256(comparableSourcePath(path));
}

function sourceMappingKey(row: ParsedCardRow): string {
  return `${cardSemanticKeyHash(row)}:${row.occurrence}`;
}

function columnIndex(reference: string): number {
  let result = 0;
  for (const character of reference) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

function validIsoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("The date is not valid.");
  }
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function parseDate(value: unknown, format: CardImportProfile["dateFormat"]): string {
  if (value instanceof Date) {
    return validIsoDate(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate()
    );
  }
  const text = String(value).trim();
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(text);
  if (iso && (format === "auto" || format === "ymd")) {
    return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const separated = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/u.exec(text);
  if (!separated) throw new Error(`Unsupported date: "${text}".`);
  const first = Number(separated[1]);
  const second = Number(separated[2]);
  let year = Number(separated[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  if (format === "auto" && first <= 12 && second <= 12) {
    throw new Error(
      `Ambiguous date "${text}". Configure the date format explicitly for this card profile.`
    );
  }
  const resolvedFormat =
    format === "auto"
      ? first > 12
        ? "dmy"
        : second > 12
          ? "mdy"
          : "dmy"
      : format;
  if (resolvedFormat === "ymd") {
    throw new Error(`Expected a year-first date, received "${text}".`);
  }
  const month = resolvedFormat === "mdy" ? first : second;
  const day = resolvedFormat === "mdy" ? second : first;
  return validIsoDate(year, month, day);
}

function parseAmount(
  value: unknown,
  profile: CardImportProfile
): { amount: string; direction: string } {
  let raw: string;
  if (typeof value === "number" && Number.isFinite(value)) {
    raw = String(value);
  } else {
    const currencyCode = new RegExp(profile.currency, "giu");
    raw = String(value)
      .trim()
      .replace(/\s/gu, "")
      .replace(currencyCode, "")
      .replace(/\p{Sc}/gu, "");
    const negativeParentheses = raw.startsWith("(") && raw.endsWith(")");
    if (negativeParentheses) raw = `-${raw.slice(1, -1)}`;
    if (
      profile.decimalSeparator === "auto" &&
      /^[+-]?[1-9]\d{0,2}[,.]\d{3}$/u.test(raw)
    ) {
      throw new Error(
        `Ambiguous amount "${raw}". Configure a decimal separator explicitly for this card profile.`
      );
    }
    const decimal =
      profile.decimalSeparator === "auto"
        ? raw.includes(",") && raw.includes(".")
          ? raw.lastIndexOf(",") > raw.lastIndexOf(".")
            ? ","
            : "."
          : raw.includes(",")
            ? ","
            : "."
        : profile.decimalSeparator;
    raw =
      decimal === ","
        ? raw.replaceAll(".", "").replace(",", ".")
        : raw.replaceAll(",", "");
  }
  let normalized = normalizeDecimal(raw);
  if (profile.invertAmountSign && !/^0+(?:\.0+)?$/u.test(normalized.amount)) {
    normalized = normalizeDecimal(
      normalized.amount.startsWith("-")
        ? normalized.amount.slice(1)
        : `-${normalized.amount}`
    );
  }
  return normalized;
}

function cell(row: unknown[], reference: string): unknown {
  return row[columnIndex(reference)] ?? null;
}

function mappedCells(row: unknown[], profile: CardImportProfile): unknown[] {
  return [
    cell(row, profile.columns.date),
    cell(row, profile.columns.description),
    ...(profile.columns.valueDate
      ? [cell(row, profile.columns.valueDate)]
      : []),
    cell(row, profile.columns.amount)
  ];
}

async function parseFile(
  path: string,
  profile: CardImportProfile
): Promise<ParsedCardRow[]> {
  if (extname(path).toLowerCase() !== ".xlsx") {
    throw new Error(`Only .xlsx card statements are supported: ${path}`);
  }
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Card statement is not a file: ${path}`);
  if (details.size > MAX_CARD_FILE_BYTES) {
    throw new Error(`Card statement exceeds the 25 MB limit: ${path}`);
  }
  const rows = await readSheet(path, profile.sheet || undefined);
  if (rows.length > MAX_CARD_ROWS) {
    throw new Error(`Card statement exceeds the ${MAX_CARD_ROWS} row limit: ${path}`);
  }
  const parsed: ParsedCardRow[] = [];
  const occurrences = new Map<string, number>();
  for (let index = profile.startRow - 1; index < rows.length; index += 1) {
    const row = rows[index] as unknown[];
    const values = mappedCells(row, profile);
    if (values.every(isBlank)) continue;
    const sourceRow = index + 1;
    try {
      if (values.some(isBlank)) {
        throw new Error("One or more configured cells are empty.");
      }
      const bookingDate = parseDate(
        cell(row, profile.columns.date),
        profile.dateFormat
      );
      const valueDate = profile.columns.valueDate
        ? parseDate(cell(row, profile.columns.valueDate), profile.dateFormat)
        : null;
      const description = String(
        cell(row, profile.columns.description)
      ).trim();
      if (!description) throw new Error("The description is empty.");
      const money = parseAmount(cell(row, profile.columns.amount), profile);
      const base = stableJson({
        profileId: profile.id,
        bookingDate,
        valueDate,
        description: normalizeText(description),
        amount: money.amount,
        currency: profile.currency
      });
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      parsed.push({
        profile,
        sourcePath: path,
        sourceRow,
        bookingDate,
        valueDate,
        description,
        amount: money.amount,
        direction: money.direction,
        occurrence,
        statementKey: ""
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}, row ${sourceRow}: ${message}`, { cause: error });
    }
  }
  const statementKey = sha256(
    stableJson(
      parsed.map((row) => ({
        semanticKey: cardSemanticKey(row),
        occurrence: row.occurrence
      }))
    )
  );
  for (const row of parsed) row.statementKey = statementKey;
  return parsed;
}

function localIds(profile: CardImportProfile): {
  connectionId: string;
  accountId: string;
  accountStableKey: string;
} {
  const accountStableKey = sha256(`manual-card|${profile.id}`);
  return {
    connectionId: sha256(`manual-card-connection|${profile.id}`),
    accountId: sha256(`manual-card-account|${profile.id}`),
    accountStableKey
  };
}

function normalizedTransaction(
  config: AppConfig,
  row: ParsedCardRow,
  existingProviderTransactionId?: string
): NormalizedTransaction {
  const ids = localIds(row.profile);
  const descriptionNormalized = normalizeText(row.description);
  const providerTransactionId =
    existingProviderTransactionId ??
    sha256(
      stableJson({
        source: "manual-card",
        profileId: row.profile.id,
        statementKey: row.statementKey,
        bookingDate: row.bookingDate,
        valueDate: row.valueDate,
        amount: row.amount,
        currency: row.profile.currency,
        descriptionNormalized,
        occurrence: row.occurrence
      })
    );
  const keyInput = {
    accountStableKey: ids.accountStableKey,
    status: "booked",
    providerTransactionId,
    bookingDate: row.bookingDate,
    valueDate: row.valueDate,
    amount: row.amount,
    currency: row.profile.currency,
    direction: row.direction,
    descriptionNormalized,
    counterparty: descriptionNormalized
  };
  return {
    movement_key: createMovementKey(keyInput),
    reconciliation_key: createReconciliationKey(keyInput),
    provider: "manual-card",
    environment: config.appEnv,
    bank_connection_id: ids.connectionId,
    account_id: ids.accountId,
    provider_transaction_id: providerTransactionId,
    entry_reference: null,
    fallback_occurrence: null,
    status: "booked",
    booking_date: row.bookingDate,
    value_date: row.valueDate,
    transaction_datetime: null,
    amount: row.amount,
    currency: row.profile.currency,
    direction: row.direction,
    description_raw: row.description,
    description_normalized: descriptionNormalized,
    merchant_name: row.description,
    creditor_name: row.direction === "expense" ? row.description : null,
    debtor_name: row.direction === "income" ? row.description : null,
    counterparty_iban_masked: null,
    counterparty_identification_hash: null,
    bank_transaction_code: null,
    merchant_category_code: null,
    balance_after: null,
    category_auto: null,
    subcategory_auto: null,
    source_raw_file: row.sourcePath,
    raw_fingerprint: sha256(
      stableJson({
        providerTransactionId,
        bookingDate: row.bookingDate,
        valueDate: row.valueDate,
        description: row.description,
        amount: row.amount,
        currency: row.profile.currency
      })
    )
  };
}

function ensureLocalAccount(
  database: SqliteDatabase,
  config: AppConfig,
  profile: CardImportProfile
): void {
  const ids = localIds(profile);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO bank_connections (
         id, provider, environment, bank_name, bank_country, psu_type, alias,
         status, created_at, last_authorized_at, reauthorization_required
       ) VALUES (?, 'manual-card', ?, ?, ?, 'personal', ?, 'LOCAL', ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         bank_name = excluded.bank_name,
         alias = excluded.alias,
         status = 'LOCAL',
         reauthorization_required = 0`
    )
    .run(
      ids.connectionId,
      config.appEnv,
      profile.bankName,
      config.defaultCountry,
      profile.name,
      now,
      now
    );
  database
    .prepare(
      `INSERT INTO accounts (
         id, bank_connection_id, provider_account_id, identification_hash,
         currency, name, display_name, account_type, product_type, active,
         first_seen_at, last_seen_at, sync_enabled, export_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CARD', 'Credit card', 1, ?, ?, 0, 1)
       ON CONFLICT(id) DO UPDATE SET
         currency = excluded.currency,
         name = excluded.name,
         display_name = excluded.display_name,
         active = 1,
         last_seen_at = excluded.last_seen_at,
         sync_enabled = 0`
    )
    .run(
      ids.accountId,
      ids.connectionId,
      profile.id,
      ids.accountStableKey,
      profile.currency,
      profile.cardName,
      profile.cardName,
      now,
      now
    );
}

function refreshStoredLocalAccount(
  database: SqliteDatabase,
  config: AppConfig,
  profile: CardImportProfile
): void {
  const ids = localIds(profile);
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `UPDATE bank_connections
         SET bank_name = ?, alias = ?
         WHERE id = ? AND provider = 'manual-card' AND environment = ?`
      )
      .run(profile.bankName, profile.name, ids.connectionId, config.appEnv);
    database
      .prepare(
        `UPDATE accounts
         SET name = ?, display_name = ?, last_seen_at = ?
         WHERE id = ? AND bank_connection_id = ?`
      )
      .run(profile.cardName, profile.cardName, now, ids.accountId, ids.connectionId);
  })();
}

function existingCardTransactions(
  database: SqliteDatabase,
  row: ParsedCardRow
): ExistingCardTransaction[] {
  const ids = localIds(row.profile);
  const rows = database
    .prepare(
      `SELECT provider_transaction_id, source_raw_file
       FROM transactions
       WHERE provider = 'manual-card'
         AND account_id = ?
         AND booking_date = ?
         AND value_date IS ?
         AND amount = ?
         AND currency = ?
         AND description_normalized = ?
         AND provider_transaction_id IS NOT NULL
       ORDER BY first_seen_at, id`
    )
    .all(
      ids.accountId,
      row.bookingDate,
      row.valueDate,
      row.amount,
      row.profile.currency,
      normalizeText(row.description)
    ) as Array<{
      provider_transaction_id: string;
      source_raw_file: string | null;
    }>;
  return rows.map((item) => ({
    providerTransactionId: item.provider_transaction_id,
    sourcePath: item.source_raw_file
  }));
}

function existingSourceMappings(
  database: SqliteDatabase,
  profileId: string,
  sourcePath: string
): {
  bySemanticKey: Map<string, SourceRowMapping>;
  bySourceRow: Map<number, string>;
} {
  const rows = database
    .prepare(
      `SELECT semantic_key_hash, occurrence, source_row, provider_transaction_id
       FROM card_import_source_rows
       WHERE profile_id = ? AND source_path_hash = ?`
    )
    .all(profileId, sourcePathHash(sourcePath)) as Array<{
      semantic_key_hash: string;
      occurrence: number;
      source_row: number | null;
      provider_transaction_id: string;
    }>;
  return {
    bySemanticKey: new Map(
      rows.map((row) => [
        `${row.semantic_key_hash}:${row.occurrence}`,
        {
          providerTransactionId: row.provider_transaction_id,
          sourceRow: row.source_row
        }
      ])
    ),
    bySourceRow: new Map(
      rows
        .filter(
          (row): row is typeof row & { source_row: number } =>
            row.source_row !== null
        )
        .map((row) => [row.source_row, row.provider_transaction_id])
    )
  };
}

function sourceRowOffset(
  rows: ParsedCardRow[],
  mappings: ReturnType<typeof existingSourceMappings>
): number | null {
  const offsets = new Set<number>();
  for (const row of rows) {
    const mapping = mappings.bySemanticKey.get(sourceMappingKey(row));
    if (mapping && mapping.sourceRow !== null) {
      offsets.add(mapping.sourceRow - row.sourceRow);
    }
  }
  if (offsets.size < 2) return null;
  if (offsets.size !== 1) return null;

  return offsets.values().next().value ?? null;
}

function clearSourceRowPositions(
  database: SqliteDatabase,
  profileId: string,
  sourcePath: string
): void {
  database
    .prepare(
      `UPDATE card_import_source_rows SET source_row = NULL
       WHERE profile_id = ? AND source_path_hash = ?`
    )
    .run(profileId, sourcePathHash(sourcePath));
}

function saveSourceMapping(
  database: SqliteDatabase,
  row: ParsedCardRow,
  providerTransactionId: string
): void {
  const now = new Date().toISOString();
  const pathHash = sourcePathHash(row.sourcePath);
  const existingByProviderTransactionId = database
    .prepare(
      `SELECT 1 FROM card_import_source_rows
       WHERE profile_id = ? AND source_path_hash = ? AND provider_transaction_id = ?`
    )
    .get(row.profile.id, pathHash, providerTransactionId);
  if (existingByProviderTransactionId) {
    database
      .prepare(
        `UPDATE card_import_source_rows
         SET semantic_key_hash = ?, occurrence = ?, source_row = ?,
             provider_transaction_id = ?, last_seen_at = ?
         WHERE profile_id = ? AND source_path_hash = ? AND provider_transaction_id = ?`
      )
      .run(
        cardSemanticKeyHash(row),
        row.occurrence,
        row.sourceRow,
        providerTransactionId,
        now,
        row.profile.id,
        pathHash,
        providerTransactionId
      );
    return;
  }
  database
    .prepare(
      `INSERT INTO card_import_source_rows (
         profile_id, source_path_hash, semantic_key_hash, occurrence,
         source_row, provider_transaction_id, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, source_path_hash, semantic_key_hash, occurrence)
        DO UPDATE SET
          provider_transaction_id = excluded.provider_transaction_id,
         source_row = excluded.source_row,
         last_seen_at = excluded.last_seen_at`
    )
    .run(
      row.profile.id,
      pathHash,
      cardSemanticKeyHash(row),
      row.occurrence,
      row.sourceRow,
      providerTransactionId,
      now,
      now
    );
}

export class CardImportService {
  private readonly profilesStore: CardImportProfilesStore;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: SqliteDatabase
  ) {
    this.profilesStore = new CardImportProfilesStore(
      config.cardImportProfilesPath
    );
  }

  public refreshStoredProfile(profile: CardImportProfile): void {
    refreshStoredLocalAccount(this.database, this.config, profile);
  }

  public async import(input: CardImportRequest): Promise<CardImportResult> {
    const request = cardImportRequestSchema.parse(input);
    const profiles = await this.profilesStore.ensure();
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const parsedFiles: Array<{
      path: string;
      profile: CardImportProfile;
      rows: ParsedCardRow[];
    }> = [];
    for (const file of request.files) {
      const profile = byId.get(file.profileId);
      if (!profile || !profile.enabled) {
        throw new Error(`Unknown or disabled card profile: ${file.profileId}`);
      }
      parsedFiles.push({
        path: file.path,
        profile,
        rows: await parseFile(file.path, profile)
      });
    }

    const repository = new TransactionRepository(this.database);
    const categorizer = new Categorizer(this.config.categorizationRulesPath);
    categorizer.reload();
    const result: CardImportResult = {
      files: [],
      rows: 0,
      inserted: 0,
      updated: 0,
      duplicates: 0,
      reconciled: 0
    };
    this.database.transaction(() => {
      for (const file of parsedFiles) {
        ensureLocalAccount(this.database, this.config, file.profile);
        const existingBySemanticKey = new Map<
          string,
          ExistingCardTransaction[]
        >();
        for (const row of file.rows) {
          const semanticKey = cardSemanticKey(row);
          if (!existingBySemanticKey.has(semanticKey)) {
            existingBySemanticKey.set(
              semanticKey,
              existingCardTransactions(this.database, row)
            );
          }
        }
        const sourceMappings = existingSourceMappings(
          this.database,
          file.profile.id,
          file.path
        );
        const stableSourceRowOffset = sourceRowOffset(file.rows, sourceMappings);
        clearSourceRowPositions(this.database, file.profile.id, file.path);
        const comparableFilePath = comparableSourcePath(file.path);
        // Two independent matching movements are strong evidence that this is
        // an overlapping export from another source. A persisted source-row
        // mapping or legacy same-path match is sufficient for an updated file,
        // while one ambiguous match from a different statement stays distinct.
        const overlapsExistingStatement =
          [...existingBySemanticKey.values()].filter(
            (transactions) => transactions.length > 0
          ).length >= 2;
        const fileResult: CardImportFileResult = {
          path: file.path,
          profileId: file.profile.id,
          rows: file.rows.length,
          inserted: 0,
          updated: 0,
          duplicates: 0,
          reconciled: 0
        };
        const sourceRowsToSave: Array<{
          row: ParsedCardRow;
          providerTransactionId: string;
        }> = [];
        for (const row of file.rows) {
          const candidates =
            existingBySemanticKey.get(cardSemanticKey(row)) ?? [];
          const sameSourceCandidates = candidates.filter(
            (candidate) =>
              candidate.sourcePath !== null &&
              comparableSourcePath(candidate.sourcePath) === comparableFilePath
          );
          const existingProviderTransactionId =
            sourceMappings.bySemanticKey.get(sourceMappingKey(row))
              ?.providerTransactionId ??
            (stableSourceRowOffset === null
              ? undefined
              : sourceMappings.bySourceRow.get(
                  row.sourceRow + stableSourceRowOffset
                )) ??
            sameSourceCandidates[row.occurrence - 1]?.providerTransactionId ??
            (overlapsExistingStatement
              ? candidates[row.occurrence - 1]?.providerTransactionId
              : undefined);
          const transaction = normalizedTransaction(
            this.config,
            row,
            existingProviderTransactionId
          );
          const category = categorizer.categorize(
            transaction.description_normalized
          );
          transaction.category_auto = category.category;
          transaction.subcategory_auto = category.subcategory;
          const outcome = repository.upsert(transaction);
          if (transaction.provider_transaction_id) {
            sourceRowsToSave.push({
              row,
              providerTransactionId: transaction.provider_transaction_id
            });
          }
          const resultField =
            outcome === "duplicate"
              ? "duplicates"
              : outcome === "reconciled"
                ? "reconciled"
                : outcome;
          fileResult[resultField] += 1;
        }
        for (const mapping of sourceRowsToSave) {
          saveSourceMapping(
            this.database,
            mapping.row,
            mapping.providerTransactionId
          );
        }
        result.files.push(fileResult);
        result.rows += fileResult.rows;
        result.inserted += fileResult.inserted;
        result.updated += fileResult.updated;
        result.duplicates += fileResult.duplicates;
        result.reconciled += fileResult.reconciled;
      }
    })();
    return result;
  }
}
