import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";

export const exportFields = [
  "movementKey",
  "date",
  "valueDate",
  "bank",
  "account",
  "accountAlias",
  "productType",
  "description",
  "merchant",
  "counterparty",
  "amount",
  "direction",
  "status",
  "categoryAuto",
  "subcategoryAuto",
  "reviewed",
  "source",
  "importedAt"
] as const;

export type ExportField = (typeof exportFields)[number];

export const exportColumnSchema = z.object({
  field: z.enum(exportFields),
  header: z.string().trim().min(1).max(120),
  enabled: z.boolean()
});

export const exportSettingsSchema = z.object({
  format: z.enum(["csv", "xlsx"]),
  csv: z.object({
    fieldSeparator: z.enum([",", ";", "\t", "|"]),
    decimalSeparator: z.enum([".", ","]),
    dateFormat: z.enum(["yyyy-mm-dd", "dd/mm/yyyy", "mm/dd/yyyy"]),
    includeBom: z.boolean()
  }),
  columns: z.array(exportColumnSchema).min(1).max(exportFields.length)
});

export type ExportSettings = z.output<typeof exportSettingsSchema>;

const defaultHeaders: Record<ExportField, string> = {
  movementKey: "MovementKey",
  date: "Date",
  valueDate: "ValueDate",
  bank: "Bank",
  account: "Account",
  accountAlias: "AccountAlias",
  productType: "ProductType",
  description: "Description",
  merchant: "Merchant",
  counterparty: "Counterparty",
  amount: "Amount",
  direction: "Direction",
  status: "Status",
  categoryAuto: "CategoryAuto",
  subcategoryAuto: "SubcategoryAuto",
  reviewed: "Reviewed",
  source: "Source",
  importedAt: "ImportedAt"
};

function parseSettings(value: unknown): ExportSettings {
  const settings = exportSettingsSchema.parse(value);
  const fields = new Set<ExportField>();
  for (const column of settings.columns) {
    if (fields.has(column.field)) {
      throw new Error(`Export field "${column.field}" is duplicated.`);
    }
    fields.add(column.field);
  }
  if (!settings.columns.some((column) => column.enabled)) {
    throw new Error("At least one export column must be enabled.");
  }
  return settings;
}

function migrateSettings(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { columns?: unknown }).columns)) {
    return value;
  }
  return {
    ...value,
    columns: (value as { columns: Array<{ field?: unknown }> }).columns.filter(
      (column) => column.field !== "currency"
    )
  };
}

export function createDefaultExportSettings(
  decimalSeparator: "." | ",",
  legacyFieldSeparator?: string
): ExportSettings {
  const detectedSeparator =
    legacyFieldSeparator === "," ||
    legacyFieldSeparator === ";" ||
    legacyFieldSeparator === "\t" ||
    legacyFieldSeparator === "|"
      ? legacyFieldSeparator
      : decimalSeparator === ","
        ? ";"
        : ",";
  return {
    format: "xlsx",
    csv: {
      fieldSeparator: detectedSeparator,
      decimalSeparator,
      dateFormat: decimalSeparator === "," ? "dd/mm/yyyy" : "yyyy-mm-dd",
      includeBom: true
    },
    columns: exportFields.map((field) => ({
      field,
      header: defaultHeaders[field],
      enabled: true
    }))
  };
}

export function exportSettingsFingerprint(settings: ExportSettings): string {
  return createHash("sha256")
    .update(JSON.stringify(settings))
    .digest("hex")
    .slice(0, 12);
}

export class ExportSettingsStore {
  public constructor(
    private readonly path: string,
    private readonly defaults: ExportSettings
  ) {}

  public async load(): Promise<ExportSettings> {
    try {
      return parseSettings(
        migrateSettings(JSON.parse(await readFile(this.path, "utf8")) as unknown)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.defaults;
      }
      throw new ConfigurationError("The export settings file is not valid.", {
        cause: error
      });
    }
  }

  public async ensure(): Promise<ExportSettings> {
    try {
      return await this.loadExisting();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return await this.save(this.defaults);
    }
  }

  private async loadExisting(): Promise<ExportSettings> {
    return parseSettings(
      migrateSettings(JSON.parse(await readFile(this.path, "utf8")) as unknown)
    );
  }

  public async save(input: unknown): Promise<ExportSettings> {
    let settings: ExportSettings;
    try {
      settings = parseSettings(input);
    } catch (error) {
      throw new ConfigurationError("The export settings are not valid.", {
        cause: error
      });
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const backup = `${this.path}.backup`;
    try {
      await copyFile(this.path, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
    return settings;
  }
}
