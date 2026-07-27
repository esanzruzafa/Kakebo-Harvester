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
}

type ExportValue = string | number | boolean | null;

const exportStateSchema = z.object({
  fingerprint: z.string().min(1),
  format: z.enum(["csv", "xlsx"]),
  movementKeys: z.array(z.string().min(1)).optional()
});

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
      : row.amount.replace(".", settings.csv.decimalSeparator),
    currency: row.currency,
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
    newMovementKeys: ReadonlySet<string>
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
        const isNew = newMovementKeys.has(row.movement_key);
        return columns.map((column): Cell => {
          const value = rowValue(row, column.field, settings, true);
          const background = isNew
            ? { backgroundColor: "#e6efe9" as const }
            : {};
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

  public async export(): Promise<{ path: string; rows: number }> {
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
      const previousKeys =
        previous?.fingerprint === fingerprint &&
        previous.format === settings.format &&
        previous.movementKeys
          ? new Set(previous.movementKeys)
          : undefined;
      const newMovementKeys = new Set(
        previousKeys
          ? rows
              .filter((row) => !previousKeys.has(row.movement_key))
              .map((row) => row.movement_key)
          : []
      );
      await backupCurrentOutput(this.config, destination, fingerprint);
      if (settings.format === "csv") {
        await this.writeCsv(temporary, rows, settings);
      } else {
        await this.writeXlsx(temporary, rows, settings, newMovementKeys);
      }
      await rename(temporary, destination);
      await writeExportState(`${this.config.exportSettingsPath}.state.json`, {
        fingerprint,
        format: settings.format,
        movementKeys: rows.map((row) => row.movement_key)
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
