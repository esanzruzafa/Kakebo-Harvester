import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CsvExporter } from "../../src/export/csv-exporter.js";
import {
  ExportSettingsStore,
  createDefaultExportSettings
} from "../../src/settings/export-settings-store.js";
import { createDatabase } from "../../src/storage/database.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("CSV export", () => {
  it("writes an Excel-compatible BOM, semicolon separator and no IBAN", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Banco Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, iban_masked, name,
           active, first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider', 'ES********12',
                   'Cuenta demo', 1, ?, ?)`
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO transactions (
           id, movement_key, reconciliation_key, provider, environment,
           bank_connection_id, account_id, status, booking_date, amount, currency,
           direction, description_raw, description_normalized, reviewed,
           first_seen_at, last_seen_at, imported_at, raw_fingerprint
         ) VALUES (
           'transaction', 'movement', 'reconcile', 'enable-banking', 'sandbox',
           'connection', 'account', 'booked', '2026-07-24', '-12.34', 'EUR',
           'expense', 'Compra; demo', 'COMPRA DEMO', 0, ?, ?, ?, 'raw'
         )`
      )
      .run(now, now, now);

    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(
      settings
    );
    const result = await new CsvExporter(config, database).export();
    const content = await readFile(result.path, "utf8");
    expect(content.charCodeAt(0)).toBe(0xfeff);
    expect(content).toContain('"Compra; demo"');
    expect(content).not.toContain("ES********12");
    expect(content.replace(/^\uFEFF/, "").split(/\r?\n/)[0]).toContain(
      "MovementKey;Date;ValueDate"
    );
    database.close();
  });

  it("archives the previous result when the export profile changes", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-profile-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    settings.columns = settings.columns.slice(0, 2);
    const store = new ExportSettingsStore(config.exportSettingsPath, settings);
    await store.save(settings);
    const exporter = new CsvExporter(config, database);
    await exporter.export();

    const firstColumn = settings.columns[0];
    if (!firstColumn) throw new Error("The default export profile has no columns.");
    settings.columns[0] = {
      ...firstColumn,
      header: "Custom key"
    };
    await store.save(settings);
    const result = await exporter.export();
    const content = await readFile(result.path, "utf8");
    const archived = await readdir(join(config.exportDirectory, "archive"));
    expect(content).toContain("Custom key;Date");
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(/^kakebo_movements_.+\.csv$/u);
    database.close();
  });

  it("creates a real XLSX workbook", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-xlsx-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "xlsx";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(
      settings
    );
    const result = await new CsvExporter(config, database).export();
    const content = await readFile(result.path);
    expect(content.subarray(0, 2).toString("ascii")).toBe("PK");
    database.close();
  });
});
