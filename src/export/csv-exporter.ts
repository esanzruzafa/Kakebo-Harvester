import {
  copyFile,
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
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ExportError } from "../errors.js";
import {
  ExportSettingsStore,
  createDefaultExportSettings,
  exportSettingsFingerprint,
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
}

export type HighlightSource = "banking" | "cards";

export interface ExportOptions {
  highlightSource?: HighlightSource | undefined;
}

type ExportValue = string | number | boolean | null;

const exportStateSchema = z.object({
  fingerprint: z.string().min(1),
  format: z.enum(["csv", "xlsx"]),
  movementKeys: z.array(z.string().min(1)).optional(),
  sourceMovementKeys: z
    .object({ banking: z.array(z.string()), cards: z.array(z.string()) })
    .optional(),
  highlightedMovementKeys: z
    .object({ banking: z.array(z.string()), cards: z.array(z.string()) })
    .optional()
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
  return /^[=+@]|^-(?!\d+(?:[.,]\d+)?$)/u.test(value) ? `'${value}` : value;
}

function formatDate(value: string | null, format: ExportSettings["csv"]["dateFormat"]): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value ?? "";
  const [year = "", month = "", day = ""] = value.split("-");
  if (format === "dd/mm/yyyy") return `${day}/${month}/${year}`;
  if (format === "mm/dd/yyyy") return `${month}/${day}/${year}`;
  return value;
}

function currencySymbol(currency: string): string {
  return (
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol"
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency
  );
}

export function spreadsheetCurrencyFormat(currency: string): string {
  const fractionDigits = currencyFractionDigits(currency);
  return `"${currencySymbol(currency)}" #,##0${
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
  return `${negative ? "-" : ""}${currencySymbol(currency)}${absolute.replace(
    ".",
    decimalSeparator
  )}`;
}

function spreadsheetDate(value: string): Date {
  const [year = 0, month = 1, day = 1] = value
    .slice(0, 10)
    .split("-")
    .map(Number);
  return new Date(year, month - 1, day);
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
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, path);
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
): Promise<void> {
  if (!(await pathExists(path))) return;
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
}

async function rotateIncompatibleOutputs(
  config: AppConfig,
  settings: ExportSettings
): Promise<ExportState | undefined> {
  const statePath = `${config.exportSettingsPath}.state.json`;
  const previous = await readExportState(statePath);
  const fingerprint = exportSettingsFingerprint(settings);
  if (previous?.fingerprint === fingerprint) return previous;
  const priorFingerprint = previous?.fingerprint ?? "legacy";
  await archiveOutput(
    config,
    join(config.exportDirectory, "kakebo_movements.csv"),
    priorFingerprint
  );
  await archiveOutput(
    config,
    join(config.exportDirectory, "kakebo_movements.xlsx"),
    priorFingerprint
  );
  return previous;
}

async function backupCurrentOutput(
  config: AppConfig,
  destination: string,
  fingerprint: string
): Promise<void> {
  if (!config.exportKeepBackup || !(await pathExists(destination))) return;
  const archiveDirectory = join(config.exportDirectory, "archive");
  await mkdir(archiveDirectory, { recursive: true });
  const extension = extname(destination);
  const stem = basename(destination, extension);
  await copyFile(
    destination,
    join(
      archiveDirectory,
      `${stem}_${timestampForFilename()}_${fingerprint}${extension}`
    )
  );
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
    settings: ExportSettings
  ): Promise<void> {
    const columns = settings.columns.filter((column) => column.enabled);
    const separator = settings.csv.fieldSeparator;
    const lines = [
      columns.map((column) => escapeCsv(column.header, separator)).join(separator),
      ...rows.map((row) =>
        columns
          .map((column) =>
            escapeCsv(rowValue(row, column.field, settings, false), separator)
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
      .map((column) => escapeCsv(column.header, separator))
      .join(separator);
    if (firstLine !== expected) throw new Error("CSV header validation failed.");
  }

  private async writeXlsx(
    temporary: string,
    rows: ExportRow[],
    settings: ExportSettings,
    highlightedKeys: Record<HighlightSource, ReadonlySet<string>>
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
          if (column.field === "amount") {
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
          if (column.field === "date" || column.field === "valueDate") {
            const rawDate = column.field === "date" ? row.movement_date : row.value_date;
            return rawDate
              ? { value: spreadsheetDate(rawDate), type: Date, format: "yyyy-mm-dd", ...background }
              : null;
          }
          const value = rowValue(row, column.field, settings, true);
          if (typeof value === "number") {
            return { value, type: Number, format: "#,##0.00", ...background };
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
    try {
      await mkdir(this.config.exportDirectory, { recursive: true });
      const previous = await rotateIncompatibleOutputs(this.config, settings);
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
      await backupCurrentOutput(this.config, destination, fingerprint);
      if (settings.format === "csv") {
        await this.writeCsv(temporary, rows, settings);
      } else {
        await this.writeXlsx(temporary, rows, settings, highlighted);
      }
      await rename(temporary, destination);
      await writeExportState(`${this.config.exportSettingsPath}.state.json`, {
        fingerprint,
        format: settings.format,
        movementKeys: rows.map((row) => row.movement_key),
        sourceMovementKeys: knownKeys,
        highlightedMovementKeys: {
          banking: [...highlighted.banking],
          cards: [...highlighted.cards]
        }
      });
      return { path: destination, rows: rows.length };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ExportError("Kakebo Harvester could not generate the export file.", {
        cause: error
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
  const total = await countGeneratedExportFiles(config);
  try {
    const entries = await readdir(config.exportDirectory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        /^kakebo_movements(?:_[^.]+)?\.(?:csv|xlsx)$/u.test(entry.name)
      ) {
        await rm(join(config.exportDirectory, entry.name));
      }
    }
    await rm(join(config.exportDirectory, "archive"), {
      recursive: true,
      force: true
    });
    await rm(`${config.exportSettingsPath}.state.json`, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return total;
}
