import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
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
    expect(content).toContain("-€12,34");
    expect(content).not.toContain("ES********12");
    expect(content.replace(/^\uFEFF/, "").split(/\r?\n/)[0]).not.toContain(
      "Currency"
    );
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
    await exporter.export({ highlightSource: "banking" });

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

  it("highlights only movements added since the previous XLSX export", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-xlsx-new-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name, active,
           first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`
      )
      .run(now, now);
    const insert = database.prepare(
      `INSERT INTO transactions (
         id, movement_key, reconciliation_key, provider, environment,
         bank_connection_id, account_id, status, booking_date, amount, currency,
         direction, description_raw, description_normalized, reviewed,
         first_seen_at, last_seen_at, imported_at, raw_fingerprint
       ) VALUES (?, ?, ?, 'enable-banking', 'sandbox', 'connection', 'account',
                 'booked', ?, ?, 'EUR', 'expense', ?, ?, 0, ?, ?, ?, ?)`
    );
    insert.run(
      "transaction-1",
      "movement-1",
      "reconcile-1",
      "2026-07-01",
      "-10.00",
      "First",
      "FIRST",
      now,
      now,
      now,
      "raw-1"
    );
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "xlsx";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(
      settings
    );
    const exporter = new CsvExporter(config, database);
    await exporter.export();

    insert.run(
      "transaction-2",
      "movement-2",
      "reconcile-2",
      "2026-07-02",
      "-20.00",
      "Second",
      "SECOND",
      now,
      now,
      now,
      "raw-2"
    );
    const withNewRow = await exporter.export({ highlightSource: "banking" });
    const highlightedWorkbook = unzipSync(await readFile(withNewRow.path));
    const highlightedStyles = Buffer.from(
      highlightedWorkbook["xl/styles.xml"] ?? []
    ).toString("utf8");
    expect(highlightedStyles.toUpperCase()).toContain("FFE6EFE9");
    expect(highlightedStyles).toContain("yyyy-mm-dd");
    expect(highlightedStyles).toContain("€");

    const withoutNewRows = await exporter.export({ highlightSource: "banking" });
    const resetWorkbook = unzipSync(await readFile(withoutNewRows.path));
    const resetStyles = Buffer.from(
      resetWorkbook["xl/styles.xml"] ?? []
    ).toString("utf8");
    expect(resetStyles.toUpperCase()).not.toContain("FFE6EFE9");
    database.close();
  });

  it("migrates the legacy standalone currency column", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-currency-migration-"));
    const config = testConfig(root);
    const settings = createDefaultExportSettings(",", ";");
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(
      settings
    );
    await writeFile(
      config.exportSettingsPath,
      JSON.stringify({
        ...settings,
        columns: [
          ...settings.columns,
          { field: "currency", header: "Currency", enabled: true }
        ]
      })
    );
    const loaded = await new ExportSettingsStore(
      config.exportSettingsPath,
      settings
    ).load();
    expect(
      loaded.columns.some(
        (column) => (column as { field: string }).field === "currency"
      )
    ).toBe(false);
  });

  it("keeps bank and card XLSX highlights independent", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-source-colors-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO bank_connections (
           id, provider, environment, bank_name, bank_country, psu_type,
           alias, status, created_at
         ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES',
                   'personal', 'Demo', 'AUTHORIZED', ?)`
      )
      .run(now);
    database
      .prepare(
        `INSERT INTO accounts (
           id, bank_connection_id, provider_account_id, name, active,
           first_seen_at, last_seen_at
         ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`
      )
      .run(now, now);
    const insert = database.prepare(
      `INSERT INTO transactions (
         id, movement_key, reconciliation_key, provider, environment,
         bank_connection_id, account_id, status, booking_date, amount, currency,
         direction, description_raw, description_normalized, reviewed,
         first_seen_at, last_seen_at, imported_at, raw_fingerprint
       ) VALUES (?, ?, ?, ?, 'sandbox', 'connection', 'account',
                 'booked', ?, '-10.00', 'EUR', 'expense', ?, ?, 0, ?, ?, ?, ?)`
    );
    const add = (id: string, provider: string, date: string): void => {
      insert.run(
        id,
        `movement-${id}`,
        `reconcile-${id}`,
        provider,
        date,
        id,
        id.toUpperCase(),
        now,
        now,
        now,
        `raw-${id}`
      );
    };
    add("bank-old", "enable-banking", "2026-07-01");
    add("card-old", "manual-card", "2026-07-02");
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "xlsx";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(
      settings
    );
    const exporter = new CsvExporter(config, database);
    await exporter.export();

    const colors = async (): Promise<string> => {
      const workbook = unzipSync(
        await readFile(join(config.exportDirectory, "kakebo_movements.xlsx"))
      );
      return Buffer.from(workbook["xl/styles.xml"] ?? [])
        .toString("utf8")
        .toUpperCase();
    };

    add("bank-new", "enable-banking", "2026-07-03");
    await exporter.export({ highlightSource: "banking" });
    expect(await colors()).toContain("FFE6EFE9");
    expect(await colors()).not.toContain("FFFAF1E2");

    add("card-new", "manual-card", "2026-07-04");
    await exporter.export({ highlightSource: "cards" });
    expect(await colors()).toContain("FFE6EFE9");
    expect(await colors()).toContain("FFFAF1E2");

    await exporter.export({ highlightSource: "cards" });
    expect(await colors()).toContain("FFE6EFE9");
    expect(await colors()).not.toContain("FFFAF1E2");

    await exporter.export({ highlightSource: "banking" });
    expect(await colors()).not.toContain("FFE6EFE9");
    expect(await colors()).not.toContain("FFFAF1E2");
    database.close();
  });
});
