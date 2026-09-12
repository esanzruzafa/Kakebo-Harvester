import {
  access,
  stat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  clearGeneratedExportFiles,
  countGeneratedExportFiles,
  CsvExporter,
  exactSpreadsheetNumber,
  spreadsheetCurrencyFormat,
  spreadsheetDate
} from "../../src/export/csv-exporter.js";
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
  it.runIf(platform() !== "win32")(
    "creates XLSX exports with owner-only permissions on POSIX",
    async () => {
      root = await mkdtemp(join(tmpdir(), "kakebo-private-xlsx-"));
      const config = testConfig(root);
      const database = createDatabase(config.databasePath);
      const settings = createDefaultExportSettings(",", ";");
      settings.format = "xlsx";
      await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);

      const output = await new CsvExporter(config, database).export();

      expect((await stat(output.path)).mode & 0o777).toBe(0o600);
      database.close();
    }
  );

  it("uses each currency's fraction digits in spreadsheet formats", () => {
    expect(spreadsheetCurrencyFormat("JPY")).toMatch(/#,##0$/u);
    expect(spreadsheetCurrencyFormat("EUR")).toMatch(/#,##0\.00$/u);
    expect(spreadsheetCurrencyFormat("KWD")).toMatch(/#,##0\.000$/u);
    expect(spreadsheetCurrencyFormat("USD")).toContain("USD");
  });

  it("uses a safe neutral symbol for malformed provider currency values", () => {
    expect(spreadsheetCurrencyFormat('EUR";[Red]')).toBe('"¤" #,##0.00');
  });

  it("does not coerce unsafe decimal amounts into spreadsheet numbers", () => {
    expect(exactSpreadsheetNumber("1234.56")).toBe(1234.56);
    expect(exactSpreadsheetNumber("9007199254740993.00")).toBeNull();
  });

  it("converts only real ISO calendar dates to spreadsheet dates", () => {
    expect(spreadsheetDate("2026-02-28")?.getFullYear()).toBe(2026);
    expect(spreadsheetDate("2026-02-28")?.getMonth()).toBe(1);
    expect(spreadsheetDate("2026-02-28")?.getDate()).toBe(28);
    expect(spreadsheetDate("2026-02-31")).toBeNull();
    expect(spreadsheetDate("not-a-date")).toBeNull();
  });

  it("clears interrupted export artifacts without counting them as results", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-cleanup-"));
    const config = testConfig(root);
    await mkdir(config.exportDirectory, { recursive: true });
    await writeFile(
      join(config.exportDirectory, "kakebo_movements.xlsx"),
      "active"
    );
    await Promise.all([
      writeFile(
        join(config.exportDirectory, ".kakebo_movements.123.456.tmp"),
        "temporary"
      ),
      writeFile(
        join(
          config.exportDirectory,
          "kakebo_movements.xlsx.123.456.rollback"
        ),
        "rollback"
      ),
      writeFile(`${config.exportSettingsPath}.state.json`, "{}")
    ]);

    await expect(countGeneratedExportFiles(config)).resolves.toBe(1);
    await expect(clearGeneratedExportFiles(config)).resolves.toBe(1);
    await expect(readdir(config.exportDirectory)).resolves.toEqual([]);
    await expect(readFile(`${config.exportSettingsPath}.state.json`)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("refuses to delete generated files through a directory link", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-linked-"));
    const config = testConfig(root);
    const linkedTarget = join(root, "linked-export-target");
    await mkdir(linkedTarget, { recursive: true });
    await writeFile(
      join(linkedTarget, "kakebo_movements.xlsx"),
      "must remain"
    );
    await mkdir(join(config.exportDirectory, ".."), { recursive: true });
    await symlink(linkedTarget, config.exportDirectory, "junction");

    await expect(clearGeneratedExportFiles(config)).rejects.toThrow(
      /symbolic link/u
    );
    await expect(
      access(join(linkedTarget, "kakebo_movements.xlsx"))
    ).resolves.toBeUndefined();
  });

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
    expect(content).toContain("-€12,34 EUR");
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
    settings.columns = settings.columns.map((column, index) => ({
      ...column,
      enabled: index < 2
    }));
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

  it("does not archive the previous export during a privacy purge regeneration", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-purge-"));
    const config = { ...testConfig(root), exportKeepBackup: true };
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
    const exporter = new CsvExporter(config, database);
    const first = await exporter.export();
    await writeFile(first.path, "deleted account movement\n");

    await exporter.export({ discardPreviousOutput: true });

    await expect(readdir(join(config.exportDirectory, "archive"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(first.path, "utf8")).not.toContain("deleted account movement");
    database.close();
  });

  it("resets source-key baselines when regenerating after a privacy purge", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-purge-baseline-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
    const exporter = new CsvExporter(config, database);
    await exporter.export();
    const previousState = JSON.parse(
      await readFile(`${config.exportSettingsPath}.state.json`, "utf8")
    ) as Record<string, unknown>;
    await writeFile(
      `${config.exportSettingsPath}.state.json`,
      JSON.stringify({
        ...previousState,
        sourceMovementKeys: { banking: ["deleted-movement"], cards: [] },
        highlightedMovementKeys: { banking: ["deleted-movement"], cards: [] }
      })
    );

    await exporter.export({ discardPreviousOutput: true });

    const state = JSON.parse(await readFile(`${config.exportSettingsPath}.state.json`, "utf8")) as {
      sourceMovementKeys: { banking: string[]; cards: string[] };
    };
    expect(state.sourceMovementKeys).toEqual({ banking: [], cards: [] });
    database.close();
  });

  it("does not use an untrusted state fingerprint in archive paths", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-state-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(
      settings
    );
    const exporter = new CsvExporter(config, database);
    await exporter.export();
    await writeFile(
      `${config.exportSettingsPath}.state.json`,
      JSON.stringify({
        fingerprint: "../../outside",
        format: "csv",
        sourceMovementKeys: { banking: [], cards: [] },
        highlightedMovementKeys: { banking: [], cards: [] }
      })
    );

    await exporter.export();

    const archived = await readdir(join(config.exportDirectory, "archive"));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatch(
      /^kakebo_movements_\d{14}_legacy\.csv$/u
    );
    database.close();
  });

  it("neutralizes formula-like CSV headers including leading whitespace", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-formula-header-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    const firstColumn = settings.columns[0];
    if (!firstColumn) throw new Error("The default export profile has no columns.");
    settings.columns[0] = {
      ...firstColumn,
      header: "  =HYPERLINK(\"https://example.invalid\")"
    };
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(
      settings
    );

    const result = await new CsvExporter(config, database).export();
    const header = (await readFile(result.path, "utf8"))
      .replace(/^\uFEFF/u, "")
      .split(/\r?\n/u)[0];

    expect(header).toContain("'=HYPERLINK");
    database.close();
  });

  it("keeps the active result when generation with a changed profile fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-rollback-"));
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
    database
      .prepare(
        `INSERT INTO transactions (
           id, movement_key, reconciliation_key, provider, environment,
           bank_connection_id, account_id, status, booking_date, amount,
           currency, direction, description_raw, description_normalized,
           reviewed, first_seen_at, last_seen_at, imported_at, raw_fingerprint
         ) VALUES ('transaction', 'movement', 'reconcile', 'enable-banking',
                   'sandbox', 'connection', 'account', 'booked', '2026-08-01',
                   '-10.00', 'EUR', 'expense', 'Original', 'ORIGINAL', 0,
                   ?, ?, ?, 'raw')`
      )
      .run(now, now, now);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    const store = new ExportSettingsStore(config.exportSettingsPath, settings);
    await store.save(settings);
    const exporter = new CsvExporter(config, database);
    const first = await exporter.export();
    const original = await readFile(first.path, "utf8");

    const firstColumn = settings.columns[0];
    if (!firstColumn) throw new Error("The default export profile has no columns.");
    settings.columns[0] = { ...firstColumn, header: "Changed key" };
    await store.save(settings);
    await writeFile(join(config.exportDirectory, "archive"), "blocked");

    await expect(exporter.export()).rejects.toThrow(
      "Kakebo Harvester could not generate the export file."
    );
    expect(await readFile(first.path, "utf8")).toBe(original);
    expect(await readFile(join(config.exportDirectory, "archive"), "utf8")).toBe(
      "blocked"
    );
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

  it("restores omitted legacy columns as disabled configuration rows", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-column-migration-"));
    const config = testConfig(root);
    const settings = createDefaultExportSettings(",", ";");
    const store = new ExportSettingsStore(config.exportSettingsPath, settings);
    await store.save(settings);
    await writeFile(
      config.exportSettingsPath,
      JSON.stringify({
        ...settings,
        columns: settings.columns.slice(0, 2)
      })
    );

    const loaded = await store.load();

    expect(loaded.columns).toHaveLength(settings.columns.length);
    expect(loaded.columns.slice(0, 2)).toEqual(settings.columns.slice(0, 2));
    expect(loaded.columns.slice(2).every((column) => !column.enabled)).toBe(
      true
    );
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
