import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { ExportError } from "../errors.js";
import type { SqliteDatabase } from "../storage/database.js";

const headers = [
  "MovementKey",
  "Date",
  "ValueDate",
  "Bank",
  "Account",
  "AccountAlias",
  "ProductType",
  "Description",
  "Merchant",
  "Counterparty",
  "Amount",
  "Currency",
  "Direction",
  "Status",
  "CategoryAuto",
  "SubcategoryAuto",
  "Reviewed",
  "Source",
  "ImportedAt"
] as const;

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

function escapeCsv(
  value: string | number | boolean | null | undefined,
  separator: string
): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.includes(separator) || /["\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function timestampForFilename(now = new Date()): string {
  return now.toISOString().replace(/\D/g, "").slice(0, 14);
}

export class CsvExporter {
  public constructor(
    private readonly config: AppConfig,
    private readonly database: SqliteDatabase
  ) {}

  public async export(): Promise<{ path: string; rows: number }> {
    const rows = this.database
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
         ORDER BY movement_date, c.bank_name, account_name, t.movement_key`
      )
      .all() as ExportRow[];

    const lines = [
      headers.join(this.config.csvSeparator),
      ...rows.map((row) =>
        [
          row.movement_key,
          row.movement_date,
          row.value_date,
          row.bank_name,
          row.account_name,
          row.account_alias,
          row.product_type,
          row.description_raw,
          row.merchant_name,
          row.counterparty_name,
          row.amount,
          row.currency,
          row.direction,
          row.status,
          row.category_auto,
          row.subcategory_auto,
          row.reviewed === 1 ? "true" : "false",
          row.provider,
          row.imported_at
        ]
          .map((value) => escapeCsv(value, this.config.csvSeparator))
          .join(this.config.csvSeparator)
      )
    ];

    const content = `\uFEFF${lines.join("\r\n")}\r\n`;
    const destination = join(this.config.exportDirectory, "kakebo_movements.csv");
    const temporary = join(
      this.config.exportDirectory,
      `.kakebo_movements.${process.pid}.${Date.now()}.tmp`
    );
    try {
      await mkdir(this.config.exportDirectory, { recursive: true });
      if (this.config.exportKeepBackup) {
        try {
          await stat(destination);
          await copyFile(
            destination,
            join(
              this.config.exportDirectory,
              `kakebo_movements_${timestampForFilename()}.csv`
            )
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      const validation = await readFile(temporary, "utf8");
      const firstLine = validation.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
      if (firstLine !== headers.join(this.config.csvSeparator)) {
        throw new Error("CSV header validation failed.");
      }
      await rename(temporary, destination);
      return { path: destination, rows: rows.length };
    } catch (error) {
      throw new ExportError("No se ha podido generar el CSV de Kakebo.", { cause: error });
    }
  }
}
