import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";
import { customFormulaSchema } from "../export/custom-formula.js";
import { writeJsonAtomically } from "./atomic-json-file.js";

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

export const builtInExportColumnSchema = z.object({
  field: z.enum(exportFields),
  header: z.string().trim().min(1).max(120),
  enabled: z.boolean()
});

export const customExportColumnSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["formula", "manual"]),
  header: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  formula: customFormulaSchema.optional()
}).superRefine((column, context) => {
  if (column.kind === "formula" && !column.formula) {
    context.addIssue({ code: "custom", path: ["formula"], message: "A formula is required." });
  }
  if (column.kind === "manual" && column.formula !== undefined) {
    context.addIssue({ code: "custom", path: ["formula"], message: "Manual columns cannot have a formula." });
  }
});

export const exportColumnSchema = z.union([builtInExportColumnSchema, customExportColumnSchema]);

export type BuiltInExportColumn = z.output<typeof builtInExportColumnSchema>;
export type CustomExportColumn = z.output<typeof customExportColumnSchema>;
export type ExportColumn = BuiltInExportColumn | CustomExportColumn;

export const exportSettingsSchema = z.object({
  schemaVersion: z.literal(2),
  format: z.enum(["csv", "xlsx"]),
  csv: z.object({
    fieldSeparator: z.enum([",", ";", "\t", "|"]),
    decimalSeparator: z.enum([".", ","]),
    dateFormat: z.enum(["yyyy-mm-dd", "dd/mm/yyyy", "mm/dd/yyyy"]),
    includeBom: z.boolean()
  }),
  columns: z.array(exportColumnSchema).min(1)
}).superRefine((settings, context) => {
  const hasEnabledCustomColumn = settings.columns.some(
    (column) => !("field" in column) && column.enabled
  );
  const enabledMovementKeys = settings.columns.filter(
    (column) => "field" in column && column.field === "movementKey" && column.enabled
  ).length;
  if (hasEnabledCustomColumn && enabledMovementKeys !== 1) {
    context.addIssue({
      code: "custom",
      path: ["columns"],
      message: "An enabled movementKey export column is required for custom columns."
    });
  }
});

export type ExportSettings = Omit<z.output<typeof exportSettingsSchema>, "schemaVersion"> & {
  schemaVersion?: 2;
};

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
  const customIds = new Set<string>();
  let enabledMovementKeys = 0;
  let hasEnabledCustomColumn = false;
  for (const column of settings.columns) {
    if ("field" in column) {
      if (fields.has(column.field)) {
        throw new Error(`Export field "${column.field}" is duplicated.`);
      }
      fields.add(column.field);
      if (column.field === "movementKey" && column.enabled) enabledMovementKeys += 1;
    } else {
      if (customIds.has(column.id)) throw new Error(`Custom export column "${column.id}" is duplicated.`);
      customIds.add(column.id);
      if (column.enabled) hasEnabledCustomColumn = true;
    }
  }
  const missingFields = exportFields.filter((field) => !fields.has(field));
  if (missingFields.length > 0) {
    throw new Error(
      `Export fields are missing from the configuration: ${missingFields.join(", ")}.`
    );
  }
  if (!settings.columns.some((column) => column.enabled)) {
    throw new Error("At least one export column must be enabled.");
  }
  if (hasEnabledCustomColumn && enabledMovementKeys !== 1) {
    throw new Error("An enabled movementKey export column is required for custom columns.");
  }
  return settings;
}

function migrateSettings(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { columns?: unknown }).columns)) {
    return value;
  }
  const columns = (
    value as { columns: Array<{ field?: unknown }> }
  ).columns.filter((column) => column.field !== "currency");
  const configuredFields = new Set(
    columns
      .map((column) => column.field)
      .filter((field): field is ExportField =>
        exportFields.includes(field as ExportField)
      )
  );
  return {
    ...value,
    schemaVersion: 2,
    columns: [
      ...columns,
      ...exportFields
        .filter((field) => !configuredFields.has(field))
        .map((field) => ({
          field,
          header: defaultHeaders[field],
          enabled: false
        }))
    ]
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
    schemaVersion: 2,
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
    await writeJsonAtomically(this.path, settings, { backup: true });
    return settings;
  }
}
