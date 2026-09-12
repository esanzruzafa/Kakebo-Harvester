import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import writeXlsxFile, {
  type Cell,
  type SheetData
} from "write-excel-file/node";
import { readSheet } from "read-excel-file/node";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ExportError } from "../errors.js";
import {
  evaluateCustomFormula,
  type CustomFormulaValue
} from "./custom-formula.js";
import {
  ExportSettingsStore,
  createDefaultExportSettings,
  exportSettingsFingerprint,
  type CustomExportColumn,
  type ExportField,
  type ExportSettings
} from "../settings/export-settings-store.js";
import type { SqliteDatabase } from "../storage/database.js";
import { currencyFractionDigits } from "../utils/currency.js";

interface ExportRow {
  movement_key: string;
  movement_date: string | null;
  value_date: string | null;
  bank_name: string;
  account_name: string | null;
  account_alias: string | null;
  product_type: string | null;
  description_raw: string | null;
  merchant_name: string | null;
  counterparty_name: string | null;
  amount: string;
  currency: string;
  direction: string;
  status: string;
  category_auto: string | null;
  subcategory_auto: string | null;
  reviewed: number;
  provider: string;
  imported_at: string;
}

interface ExportState {
  fingerprint: string;
  format: "csv" | "xlsx";
  movementKeys?: string[] | undefined;
  sourceMovementKeys?: Record<HighlightSource, string[]> | undefined;
  highlightedMovementKeys?: Record<HighlightSource, string[]> | undefined;
  customValues?: Record<string, Record<string, ExportValue | { date: string }>> | undefined;
}

export type HighlightSource = "banking" | "cards";

export interface ExportOptions {
  highlightSource?: HighlightSource | undefined;
}

type ExportValue = string | number | boolean | null;
type CustomExportValue = ExportValue | Date;

const exportStateSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{12}$/u),
  format: z.enum(["csv", "xlsx"]),
  movementKeys: z.array(z.string().min(1)).optional(),
  sourceMovementKeys: z
    .object({ banking: z.array(z.string()), cards: z.array(z.string()) })
    .optional(),
  highlightedMovementKeys: z
    .object({ banking: z.array(z.string()), cards: z.array(z.string()) })
    .optional(),
  customValues: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({ date: z.iso.datetime() })]))).optional()
});

const HIGHLIGHT_COLORS: Record<HighlightSource, string> = {
  banking: "#e6efe9",
  cards: "#faf1e2"
};

function sourceForRow(row: ExportRow): HighlightSource {
  return row.provider === "manual-card" ? "cards" : "banking";
}

function sourceKeys(rows: ExportRow[]): Record<HighlightSource, string[]> {
  return {
    banking: rows.filter((row) => sourceForRow(row) === "banking").map((row) => row.movement_key),
    cards: rows.filter((row) => sourceForRow(row) === "cards").map((row) => row.movement_key)
  };
}

function timestampForFilename(now = new Date()): string {
  return now.toISOString().replace(/\D/g, "").slice(0, 14);
}

function decimalSeparatorForLocale(locale: string): "." | "," {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.1);
  return parts.find((part) => part.type === "decimal")?.value === "," ? "," : ".";
}

export function defaultExportSettings(
  config: AppConfig,
  locale = Intl.DateTimeFormat().resolvedOptions().locale
): ExportSettings {
  const settings = createDefaultExportSettings(
    decimalSeparatorForLocale(locale),
    config.csvSeparator
  );
  if (
    existsSync(join(config.exportDirectory, "kakebo_movements.csv")) &&
    !existsSync(join(config.exportDirectory, "kakebo_movements.xlsx"))
  ) {
    settings.format = "csv";
  }
  return settings;
}

export function exportOutputPath(
  config: AppConfig,
  settings: ExportSettings
): string {
  return join(config.exportDirectory, `kakebo_movements.${settings.format}`);
}

function safeSpreadsheetText(value: string): string {
  const trimmedStart = value.trimStart();
  const formulaLike =
    /^[=+@]/u.test(trimmedStart) ||
    (/^-/u.test(trimmedStart) &&
      !/^-\d+(?:[.,]\d+)?$/u.test(trimmedStart));
  return formulaLike ? `'${value}` : value;
}

function formatDate(value: string | null, format: ExportSettings["csv"]["dateFormat"]): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value ?? "";
  const [year = "", month = "", day = ""] = value.split("-");
  if (format === "dd/mm/yyyy") return `${day}/${month}/${year}`;
  if (format === "mm/dd/yyyy") return `${month}/${day}/${year}`;
  return value;
}

function currencyCode(currency: string): string | undefined {
  const normalized = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}

function currencySymbol(currency: string): string {
  const code = currencyCode(currency);
  if (!code) return "¤";
  try {
    const symbol = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol"
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value;
    return symbol && !/["\r\n]/u.test(symbol) ? symbol : code;
  } catch {
    return code;
  }
}

function currencyDisplay(currency: string): string {
  const code = currencyCode(currency);
  if (!code) return "¤";
  const symbol = currencySymbol(code);
  return symbol === code ? code : `${symbol} ${code}`;
}

interface ArchivedOutput {
  originalPath: string;
  archivePath: string;
}

export function spreadsheetCurrencyFormat(currency: string): string {
  const fractionDigits = currencyFractionDigits(currency);
  return `"${currencyDisplay(currency)}" #,##0${
    fractionDigits > 0 ? `.${"0".repeat(fractionDigits)}` : ""
  }`;
}

export function exactSpreadsheetNumber(value: string): number | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  const sign = match[1] === "-" ? -1n : 1n;
  const scaled = sign * BigInt(`${match[2]}${fraction}`);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  const number = Number(scaled) / 10 ** fraction.length;
  const roundTrip = Math.round(number * 10 ** fraction.length);
  return Number.isSafeInteger(roundTrip) && BigInt(roundTrip) === scaled
    ? number
    : null;
}

function formatMoney(
  value: string,
  currency: string,
  decimalSeparator: "." | ","
): string {
  const negative = value.startsWith("-");
  const absolute = negative ? value.slice(1) : value;
  const symbol = currencySymbol(currency);
  const code = currencyCode(currency);
  return `${negative ? "-" : ""}${symbol}${absolute.replace(
    ".",
    decimalSeparator
  )}${code && code !== symbol ? ` ${code}` : ""}`;
}

export function spreadsheetDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}

function rowValue(
  row: ExportRow,
  field: ExportField,
  settings: ExportSettings,
  forSpreadsheet: boolean
): ExportValue {
  const values: Record<ExportField, ExportValue> = {
    movementKey: row.movement_key,
    date: forSpreadsheet
      ? row.movement_date
      : formatDate(row.movement_date, settings.csv.dateFormat),
    valueDate: forSpreadsheet
      ? row.value_date
      : formatDate(row.value_date, settings.csv.dateFormat),
    bank: row.bank_name,
    account: row.account_name,
    accountAlias: row.account_alias,
    productType: row.product_type,
    description: row.description_raw,
    merchant: row.merchant_name,
    counterparty: row.counterparty_name,
    amount: forSpreadsheet
      ? Number(row.amount)
      : formatMoney(row.amount, row.currency, settings.csv.decimalSeparator),
    direction: row.direction,
    status: row.status,
    categoryAuto: row.category_auto,
    subcategoryAuto: row.subcategory_auto,
    reviewed: row.reviewed === 1,
    source: row.provider,
    importedAt: row.imported_at
  };
  const value = values[field];
  return typeof value === "string" && field !== "amount"
    ? safeSpreadsheetText(value)
    : value;
}

function formulaValues(row: ExportRow): Record<ExportField, CustomFormulaValue> {
  return {
    movementKey: row.movement_key,
    date: row.movement_date,
    valueDate: row.value_date,
    bank: row.bank_name,
    account: row.account_name,
    accountAlias: row.account_alias,
    productType: row.product_type,
    description: row.description_raw,
    merchant: row.merchant_name,
    counterparty: row.counterparty_name,
    amount: exactSpreadsheetNumber(row.amount),
    direction: row.direction,
    status: row.status,
    categoryAuto: row.category_auto,
    subcategoryAuto: row.subcategory_auto,
    reviewed: row.reviewed === 1,
    source: row.provider,
    importedAt: row.imported_at
  };
}

function customValue(
  row: ExportRow,
  column: CustomExportColumn,
  previous: ReadonlyMap<string, ReadonlyMap<string, CustomExportValue>>
): CustomExportValue {
  const persisted = previous.get(row.movement_key)?.get(column.id);
  if (persisted !== undefined) return persisted;
  if (column.kind === "manual") return "";
  if (!column.formula) throw new Error("Formula export columns require a formula.");
  if (/\bamount\b/u.test(column.formula) && exactSpreadsheetNumber(row.amount) === null) {
    throw new Error("Custom formulas cannot use an amount that is not exactly representable.");
  }
  return evaluateCustomFormula(column.formula, formulaValues(row));
}

function safeCustomValue(value: CustomExportValue): CustomExportValue {
  return typeof value === "string" ? safeSpreadsheetText(value) : value;
}

function csvCustomValue(value: CustomExportValue, decimalSeparator: "." | ","): ExportValue {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (typeof normalized === "number" && decimalSeparator === ",") return String(normalized).replace(".", ",");
  return typeof normalized === "string" ? safeSpreadsheetText(normalized) : normalized;
}

function readCustomValue(value: unknown): CustomExportValue {
  if (value === null || value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return "";
}

function parseCsv(content: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === separator) {
      row.push(value);
      value = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

async function previousCustomValues(
  path: string,
  settings: ExportSettings
): Promise<Map<string, Map<string, CustomExportValue>>> {
  const columns = settings.columns.filter((column) => column.enabled);
  const movementKeyIndex = columns.findIndex(
    (column) => "field" in column && column.field === "movementKey"
  );
  const customColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(
      (entry): entry is { column: CustomExportColumn; index: number } =>
        !("field" in entry.column)
    );
  if (movementKeyIndex < 0 || customColumns.length === 0) return new Map();

  let rows: readonly (readonly unknown[])[];
  if (settings.format === "csv") {
    rows = parseCsv((await readFile(path, "utf8")).replace(/^\uFEFF/u, ""), settings.csv.fieldSeparator);
  } else {
    try {
      rows = await readSheet(path, "Movements");
    } catch (error) {
      if (error instanceof Error && error.name === "SheetNotFoundError") return new Map();
      throw error;
    }
  }
  const expectedHeaders = columns.map((column) =>
    settings.format === "csv" ? safeSpreadsheetText(column.header) : column.header
  );
  const header = rows[0] ?? [];
  if (header.length !== expectedHeaders.length ||
      header.some((value, index) => value !== expectedHeaders[index])) return new Map();
  const values = new Map<string, Map<string, CustomExportValue>>();
  for (const row of rows.slice(1)) {
    const movementKey = row[movementKeyIndex];
    if (typeof movementKey !== "string" || movementKey.length === 0) continue;
    values.set(
      movementKey,
      new Map(
        customColumns.map(({ column, index }) => [column.id, readCustomValue(row[index] ?? "")])
      )
    );
  }
  return values;
}

function stateCustomValues(values: ReadonlyMap<string, ReadonlyMap<string, CustomExportValue>>): Record<string, Record<string, ExportValue | { date: string }>> {
  return Object.fromEntries([...values].map(([movementKey, columns]) => [
    movementKey,
    Object.fromEntries([...columns].map(([id, value]) => [id, value instanceof Date ? { date: value.toISOString() } : value]))
  ]));
}

function customValuesFromState(state: ExportState | undefined): Map<string, Map<string, CustomExportValue>> {
  return new Map(Object.entries(state?.customValues ?? {}).map(([key, values]) => [key, new Map(Object.entries(values).map(([id, value]) => [id, typeof value === "object" && value !== null ? new Date(value.date) : value]))]));
}

function escapeCsv(value: ExportValue, separator: string): string {
  const text = value === null ? "" : String(value);
  if (text.includes(separator) || /["\r\n]/u.test(text)) {
    return `"${text.replace(/"/gu, '""')}"`;
  }
  return text;
}

async function readExportState(path: string): Promise<ExportState | undefined> {
  try {
    return exportStateSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError
    ) {
      return undefined;
    }
    throw error;
  }
}

async function writeExportState(path: string, state: ExportState): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function archiveOutput(
  config: AppConfig,
  path: string,
  fingerprint: string
): Promise<ArchivedOutput | undefined> {
  if (!(await pathExists(path))) return undefined;
  const archiveDirectory = join(config.exportDirectory, "archive");
  await mkdir(archiveDirectory, { recursive: true });
  const extension = extname(path);
  const stem = basename(path, extension);
  let destination = join(
    archiveDirectory,
    `${stem}_${timestampForFilename()}_${fingerprint}${extension}`
  );
  let sequence = 1;
  while (await pathExists(destination)) {
    destination = join(
      archiveDirectory,
      `${stem}_${timestampForFilename()}_${fingerprint}_${sequence}${extension}`
    );
    sequence += 1;
  }
  await rename(path, destination);
  return { originalPath: path, archivePath: destination };
}

async function rotateIncompatibleOutputs(
  config: AppConfig,
  previous: ExportState | undefined
): Promise<ArchivedOutput[]> {
  const priorFingerprint = previous?.fingerprint ?? "legacy";
  const archived: ArchivedOutput[] = [];
  try {
    for (const extension of ["csv", "xlsx"] as const) {
      const result = await archiveOutput(
        config,
        join(config.exportDirectory, `kakebo_movements.${extension}`),
        priorFingerprint
      );
      if (result) archived.push(result);
    }
    return archived;
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const output of archived.reverse()) {
      await rename(output.archivePath, output.originalPath).catch(
        (rollbackError: unknown) => rollbackFailures.push(rollbackError)
      );
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "Export rotation failed and one or more previous files could not be restored.",
        { cause: error }
      );
    }
    throw error;
  }
}

async function backupCurrentOutput(
  config: AppConfig,
  destination: string,
  fingerprint: string
): Promise<string | undefined> {
  if (!config.exportKeepBackup || !(await pathExists(destination))) return undefined;
  const archiveDirectory = join(config.exportDirectory, "archive");
  await mkdir(archiveDirectory, { recursive: true });
  const extension = extname(destination);
  const stem = basename(destination, extension);
  let backupPath = join(
    archiveDirectory,
    `${stem}_${timestampForFilename()}_${fingerprint}${extension}`
  );
  let sequence = 1;
  while (await pathExists(backupPath)) {
    backupPath = join(
      archiveDirectory,
      `${stem}_${timestampForFilename()}_${fingerprint}_${sequence}${extension}`
    );
    sequence += 1;
  }
  await copyFile(destination, backupPath);
  return backupPath;
}

export class CsvExporter {
  private readonly settingsStore: ExportSettingsStore;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: SqliteDatabase,
    locale?: string
  ) {
    this.settingsStore = new ExportSettingsStore(
      config.exportSettingsPath,
      defaultExportSettings(config, locale)
    );
  }

  private rows(): ExportRow[] {
    return this.database
      .prepare(
        `SELECT
           t.movement_key,
           COALESCE(t.booking_date, substr(t.transaction_datetime, 1, 10), t.value_date)
             AS movement_date,
           t.value_date,
           c.bank_name,
           COALESCE(a.display_name, a.name) AS account_name,
           a.account_alias,
           COALESCE(a.product_type, a.account_type) AS product_type,
           t.description_raw,
           t.merchant_name,
           CASE WHEN t.direction = 'expense' THEN t.creditor_name ELSE t.debtor_name END
             AS counterparty_name,
           t.amount,
           t.currency,
           t.direction,
           t.status,
           t.category_auto,
           t.subcategory_auto,
           t.reviewed,
           t.provider,
           t.imported_at
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN bank_connections c ON c.id = t.bank_connection_id
         WHERE a.export_enabled = 1
         ORDER BY movement_date, c.bank_name, account_name, t.movement_key`
      )
      .all() as ExportRow[];
  }

  private async writeCsv(
    temporary: string,
    rows: ExportRow[],
    settings: ExportSettings,
    previous: ReadonlyMap<string, ReadonlyMap<string, CustomExportValue>>
  ): Promise<void> {
    const columns = settings.columns.filter((column) => column.enabled);
    const separator = settings.csv.fieldSeparator;
    const lines = [
      columns
        .map((column) =>
          escapeCsv(safeSpreadsheetText(column.header), separator)
        )
        .join(separator),
      ...rows.map((row) =>
        columns
          .map((column) =>
            escapeCsv(
              "field" in column
                ? rowValue(row, column.field, settings, false)
                : csvCustomValue(customValue(row, column, previous), settings.csv.decimalSeparator),
              separator
            )
          )
          .join(separator)
      )
    ];
    const content = `${settings.csv.includeBom ? "\uFEFF" : ""}${lines.join(
      "\r\n"
    )}\r\n`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    const validation = await readFile(temporary, "utf8");
    const firstLine = validation.replace(/^\uFEFF/u, "").split(/\r?\n/u, 1)[0];
    const expected = columns
      .map((column) =>
        escapeCsv(safeSpreadsheetText(column.header), separator)
      )
      .join(separator);
    if (firstLine !== expected) throw new Error("CSV header validation failed.");
  }

  private async writeXlsx(
    temporary: string,
    rows: ExportRow[],
    settings: ExportSettings,
    highlightedKeys: Record<HighlightSource, ReadonlySet<string>>,
    previous: ReadonlyMap<string, ReadonlyMap<string, CustomExportValue>>
  ): Promise<void> {
    const columns = settings.columns.filter((column) => column.enabled);
    const header: Cell[] = columns.map((column) => ({
      value: column.header,
      type: String,
      fontWeight: "bold",
      textColor: "#fffdf8",
      backgroundColor: "#1f5a45",
      wrap: true
    }));
    const data: SheetData = [
      header,
      ...rows.map((row) => {
        const source = sourceForRow(row);
        const isNew = highlightedKeys[source].has(row.movement_key);
        return columns.map((column): Cell => {
          const background = isNew
            ? { backgroundColor: HIGHLIGHT_COLORS[source] }
            : {};
          if ("field" in column && column.field === "amount") {
            const exactNumber = exactSpreadsheetNumber(row.amount);
            if (exactNumber === null) {
              return {
                value: safeSpreadsheetText(
                  formatMoney(row.amount, row.currency, ".")
                ),
                type: String,
                format: "@",
                ...background
              };
            }
            return {
              value: exactNumber,
              type: Number,
              format: spreadsheetCurrencyFormat(row.currency),
              ...background
            };
          }
          if ("field" in column && (column.field === "date" || column.field === "valueDate")) {
            const rawDate = column.field === "date" ? row.movement_date : row.value_date;
            if (!rawDate) return null;
            const date = spreadsheetDate(rawDate);
            return date
              ? { value: date, type: Date, format: "yyyy-mm-dd", ...background }
              : {
                  value: safeSpreadsheetText(rawDate),
                  type: String,
                  format: "@",
                  ...background
                };
          }
          const value = "field" in column
            ? rowValue(row, column.field, settings, true)
            : safeCustomValue(customValue(row, column, previous));
          if (value instanceof Date) {
            return { value, type: Date, format: "yyyy-mm-dd", ...background };
          }
          if (typeof value === "number") {
            return { value, type: Number, format: "#,##0.###############", ...background };
          }
          if (typeof value === "boolean") {
            return { value, type: Boolean, ...background };
          }
          if (typeof value === "string") {
            return {
              value,
              type: String,
              format: "@",
              wrap: true,
              ...background
            };
          }
          return isNew ? { value: "", type: String, ...background } : null;
        });
      })
    ];
    await writeXlsxFile(data, {
      sheet: "Movements",
      stickyRowsCount: 1,
      columns: columns.map((column) => ({
        width: Math.max(12, Math.min(42, column.header.length + 4))
      }))
    }).toFile(temporary);
  }

  public async export(options: ExportOptions = {}): Promise<{ path: string; rows: number }> {
    const rows = this.rows();
    const settings = await this.settingsStore.ensure();
    const fingerprint = exportSettingsFingerprint(settings);
    const destination = exportOutputPath(this.config, settings);
    const temporary = join(
      this.config.exportDirectory,
      `.kakebo_movements.${process.pid}.${Date.now()}.tmp`
    );
    const rollback = `${destination}.${process.pid}.${Date.now()}.rollback`;
    const statePath = `${this.config.exportSettingsPath}.state.json`;
    let archivedOutputs: ArchivedOutput[] = [];
    let backupPath: string | undefined;
    let destinationStaged = false;
    let destinationInstalled = false;
    let committed = false;
    try {
      await mkdir(this.config.exportDirectory, { recursive: true });
      const previous = await readExportState(statePath);
      const compatible = previous?.fingerprint === fingerprint && previous.format === settings.format;
      const currentKeys = sourceKeys(rows);
      const knownKeys = compatible && previous.sourceMovementKeys
        ? previous.sourceMovementKeys
        : currentKeys;
      const highlighted = compatible && previous.highlightedMovementKeys
        ? {
            banking: new Set(previous.highlightedMovementKeys.banking),
            cards: new Set(previous.highlightedMovementKeys.cards)
          }
        : { banking: new Set<string>(), cards: new Set<string>() };
      if (options.highlightSource && compatible && previous.sourceMovementKeys) {
        const source = options.highlightSource;
        const prior = new Set(knownKeys[source]);
        highlighted[source] = new Set(currentKeys[source].filter((key) => !prior.has(key)));
        knownKeys[source] = currentKeys[source];
      }
      for (const source of ["banking", "cards"] as const) {
        const current = new Set(currentKeys[source]);
        highlighted[source] = new Set([...highlighted[source]].filter((key) => current.has(key)));
      }
      const customValues = compatible ? customValuesFromState(previous) : new Map<string, Map<string, CustomExportValue>>();
      if (compatible && (await pathExists(destination))) {
        for (const [key, values] of await previousCustomValues(destination, settings)) customValues.set(key, values);
      }
      const customColumns = settings.columns.filter((column): column is CustomExportColumn => !('field' in column) && column.enabled);
      for (const row of rows) {
        const values = customValues.get(row.movement_key) ?? new Map<string, CustomExportValue>();
        for (const column of customColumns) values.set(column.id, customValue(row, column, customValues));
        customValues.set(row.movement_key, values);
      }
      if (settings.format === "csv") {
        await this.writeCsv(temporary, rows, settings, customValues);
      } else {
        await this.writeXlsx(temporary, rows, settings, highlighted, customValues);
        if (process.platform !== "win32") await chmod(temporary, 0o600);
      }
      if (compatible) {
        backupPath = await backupCurrentOutput(
          this.config,
          destination,
          fingerprint
        );
        if (await pathExists(destination)) {
          await rename(destination, rollback);
          destinationStaged = true;
        }
      } else {
        archivedOutputs = await rotateIncompatibleOutputs(
          this.config,
          previous
        );
      }
      await rename(temporary, destination);
      destinationInstalled = true;
      await writeExportState(statePath, {
        fingerprint,
        format: settings.format,
        movementKeys: rows.map((row) => row.movement_key),
        sourceMovementKeys: knownKeys,
        highlightedMovementKeys: {
          banking: [...highlighted.banking],
          cards: [...highlighted.cards]
        },
        customValues: stateCustomValues(customValues)
      });
      committed = true;
      if (destinationStaged) {
        await rm(rollback, { force: true }).catch(() => undefined);
      }
      return { path: destination, rows: rows.length };
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      await rm(temporary, { force: true }).catch((cleanupError: unknown) =>
        rollbackFailures.push(cleanupError)
      );
      if (!committed) {
        if (destinationInstalled) {
          await rm(destination, { force: true }).catch((cleanupError: unknown) =>
            rollbackFailures.push(cleanupError)
          );
        }
        if (destinationStaged) {
          await rename(rollback, destination).catch((cleanupError: unknown) =>
            rollbackFailures.push(cleanupError)
          );
        }
        for (const output of archivedOutputs.reverse()) {
          await rename(output.archivePath, output.originalPath).catch(
            (cleanupError: unknown) => rollbackFailures.push(cleanupError)
          );
        }
        if (backupPath) {
          await rm(backupPath, { force: true }).catch((cleanupError: unknown) =>
            rollbackFailures.push(cleanupError)
          );
        }
      }
      throw new ExportError("Kakebo Harvester could not generate the export file.", {
        cause:
          rollbackFailures.length > 0
            ? new AggregateError(
                [error, ...rollbackFailures],
                "Export failed and rollback did not complete cleanly."
              )
            : error
      });
    }
  }
}

export async function countGeneratedExportFiles(
  config: AppConfig
): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(config.exportDirectory, {
      withFileTypes: true
    });
    total += entries.filter(
      (entry) =>
        entry.isFile() &&
        /^kakebo_movements(?:_[^.]+)?\.(?:csv|xlsx)$/u.test(entry.name)
    ).length;
    const archive = entries.find(
      (entry) => entry.isDirectory() && entry.name === "archive"
    );
    if (archive) {
      const archived = await readdir(join(config.exportDirectory, "archive"), {
        withFileTypes: true
      });
      total += archived.filter(
        (entry) =>
          entry.isFile() &&
          /^kakebo_movements(?:_[^.]+)?\.(?:csv|xlsx)$/u.test(entry.name)
      ).length;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return total;
}

export async function clearGeneratedExportFiles(
  config: AppConfig
): Promise<number> {
  try {
    if ((await lstat(config.exportDirectory)).isSymbolicLink()) {
      throw new Error("Refusing to clear a symbolic link export directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const total = await countGeneratedExportFiles(config);
  const failures: unknown[] = [];
  try {
    const entries = await readdir(config.exportDirectory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (/^kakebo_movements(?:_[^.]+)?\.(?:csv|xlsx)$/u.test(entry.name) ||
          /^\.kakebo_movements\.\d+\.\d+\.tmp$/u.test(entry.name) ||
          /^kakebo_movements\.(?:csv|xlsx)\.\d+\.\d+\.rollback$/u.test(
            entry.name
          ))
      ) {
        await rm(join(config.exportDirectory, entry.name)).catch((error: unknown) => {
          failures.push(error);
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(join(config.exportDirectory, "archive"), {
    recursive: true,
    force: true
  }).catch((error: unknown) => failures.push(error));
  await rm(`${config.exportSettingsPath}.state.json`, { force: true }).catch(
    (error: unknown) => failures.push(error)
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more generated export files could not be removed."
    );
  }
  return total;
}
