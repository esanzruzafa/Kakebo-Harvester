import {
  access,
  stat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { readSheet } from "read-excel-file/node";
import writeXlsxFile, { type SheetData } from "write-excel-file/node";
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
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("CSV export", () => {
  it.each(["csv", "xlsx"] as const)("archives the opposite format when retrying a pre-install %s transaction", async (format) => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-format-recovery-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    try {
      const settings = createDefaultExportSettings(",", ";");
      const store = new ExportSettingsStore(config.exportSettingsPath, settings);
      settings.format = format === "csv" ? "xlsx" : "csv";
      await store.save(settings);
      const exporter = new CsvExporter(config, database);
      const oldOutput = await exporter.export();
      const oldBytes = await readFile(oldOutput.path);
      const statePath = `${config.exportSettingsPath}.state.json`;
      const oldState = await readFile(statePath);
      settings.format = format;
      await store.save(settings);
      const output = await exporter.export();
      const generated = await readFile(output.path);
      const state = JSON.parse(await readFile(statePath, "utf8")) as unknown;
      await rm(join(config.exportDirectory, "archive"), { recursive: true });
      await rm(output.path);
      await writeFile(oldOutput.path, oldBytes);
      await writeFile(statePath, oldState);
      const temporaryOutput = ".kakebo_movements.999.111.tmp";
      await writeFile(join(config.exportDirectory, temporaryOutput), generated);
      await writeFile(`${statePath}.pending`, JSON.stringify({
        state, settings, temporaryOutput,
        outputHash: createHash("sha256").update(generated).digest("hex")
      }));
      const realRm = fsPromises.rm;
      let blockedPath = join(config.exportDirectory, temporaryOutput);
      const removal = vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
        if (String(path) === blockedPath) throw new Error("Simulated recovery cleanup failure");
        return realRm(path, options);
      });
      syncBuiltinESMExports();
      await expect(exporter.export()).rejects.toThrow();
      await expect(access(`${statePath}.pending`)).resolves.toBeUndefined();
      expect(await readFile(statePath)).toEqual(oldState);
      blockedPath = `${statePath}.pending`;
      await expect(exporter.export()).rejects.toThrow();
      await expect(access(join(config.exportDirectory, temporaryOutput))).rejects.toMatchObject({ code: "ENOENT" });
      removal.mockRestore();
      syncBuiltinESMExports();
      await exporter.export();
      await expect(access(oldOutput.path)).rejects.toMatchObject({ code: "ENOENT" });
      const archives = await readdir(join(config.exportDirectory, "archive"));
      expect(archives).toHaveLength(1);
      expect(await readFile(join(config.exportDirectory, "archive", archives[0] ?? "missing-archive"))).toEqual(oldBytes);
    } finally {
      database.close();
    }
  });

  it.each(["csv", "xlsx"] as const)("restores a stranded %s rollback when generated files are missing", async (format) => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-rollback-recovery-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    try {
      const settings = createDefaultExportSettings(",", ";");
      settings.format = format;
      await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
      const exporter = new CsvExporter(config, database);
      const output = await exporter.export();
      const original = await readFile(output.path);
      const statePath = `${config.exportSettingsPath}.state.json`;
      const state = JSON.parse(await readFile(statePath, "utf8")) as unknown;
      const rollbackOutput = `kakebo_movements.${format}.999.111.rollback`;
      await rename(output.path, join(config.exportDirectory, rollbackOutput));
      await writeFile(`${statePath}.pending`, JSON.stringify({
        state, settings, rollbackOutput,
        temporaryOutput: ".kakebo_movements.999.111.tmp",
        outputHash: "0".repeat(64)
      }));
      await exporter.export();
      if (format === "csv") expect(await readFile(output.path)).toEqual(original);
      else expect(await readSheet(output.path)).toEqual(await readSheet(original));
      await expect(access(`${statePath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(config.exportDirectory, rollbackOutput))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      database.close();
    }
  });

  it.each(["csv", "xlsx"] as const)("keeps the %s journal if normal rollback cleanup fails", async (format) => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-cleanup-recovery-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    try {
      const settings = createDefaultExportSettings(",", ";");
      settings.format = format;
      await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
      const exporter = new CsvExporter(config, database);
      const output = await exporter.export();
      const realRm = fsPromises.rm;
      const removal = vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
        if (String(path).endsWith(".rollback")) throw new Error("Simulated rollback cleanup failure");
        return realRm(path, options);
      });
      syncBuiltinESMExports();
      await expect(exporter.export()).rejects.toThrow();
      const pendingPath = `${config.exportSettingsPath}.state.json.pending`;
      await expect(access(pendingPath)).resolves.toBeUndefined();
      await expect(access(output.path)).resolves.toBeUndefined();
      removal.mockRestore();
      syncBuiltinESMExports();
      await exporter.export();
      await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(config.exportDirectory)).filter((name) => name.endsWith(".rollback"))).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each(["csv", "xlsx"] as const)(
    "preserves custom values by movement key in %s exports and initializes only new rows",
    async (format) => {
      root = await mkdtemp(join(tmpdir(), "kakebo-export-custom-values-"));
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
      const insertMovement = database.prepare(
        `INSERT INTO transactions (
           id, movement_key, reconciliation_key, provider, environment,
           bank_connection_id, account_id, status, booking_date, amount, currency,
           direction, description_raw, description_normalized, reviewed,
           first_seen_at, last_seen_at, imported_at, raw_fingerprint
         ) VALUES (?, ?, ?, 'enable-banking', 'sandbox', 'connection', 'account',
                   'booked', ?, '-12.34', 'EUR', 'expense', ?, ?, 0, ?, ?, ?, ?)`
      );
      const addMovement = (id: string, description: string): void => {
        insertMovement.run(
          id,
          `movement-${id}`,
          `reconcile-${id}`,
          "2026-09-01",
          description,
          description.toUpperCase(),
          now,
          now,
          now,
          `raw-${id}`
        );
      };
      addMovement("one", "Coffee");

      const settings = createDefaultExportSettings(",", ";");
      settings.format = format;
      settings.columns.push(
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "formula",
          header: "Formula label",
          enabled: true,
          formula: 'concat("=", upper(description))'
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "manual",
          header: "Manual note",
          enabled: true
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          kind: "formula",
          header: "Tiny number",
          enabled: true,
          formula: "amount / 1000000000"
        }
      );
      const settingsStore = new ExportSettingsStore(config.exportSettingsPath, settings);
      if (format === "xlsx") {
        await settingsStore.save({
          ...settings,
          csv: { ...settings.csv, fieldSeparator: "|" }
        });
      }
      await settingsStore.save(settings);
      const exporter = new CsvExporter(config, database);
      const first = await exporter.export();

      if (format === "csv") {
        const lines = (await readFile(first.path, "utf8")).replace(/^\uFEFF/u, "").trim().split(/\r?\n/u);
        const header = lines[0]?.split(";") ?? [];
        const formulaIndex = header.indexOf("Formula label");
        const manualIndex = header.indexOf("Manual note");
        const row = lines[1]?.split(";") ?? [];
        row[formulaIndex] = "Edited formula";
        row[manualIndex] = "Edited manual";
        lines[1] = row.join(";");
        await writeFile(first.path, `${lines.join("\r\n")}\r\n`);
      } else {
        const header = settings.columns.filter((column) => column.enabled);
        const data: SheetData = [
          header.map((column) => ({ value: column.header, type: String })),
          header.map((column) => ({
            value: "field" in column
              ? column.field === "movementKey" ? "movement-one" : "source value"
              : column.kind === "formula" ? "Edited formula" : "  Edited manual  ",
            type: String
          }))
        ];
        await writeXlsxFile(data, { sheet: "Movements" }).toFile(first.path);
      }

      if (format === "xlsx") {
        const statePath = `${config.exportSettingsPath}.state.json`;
        const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
        state.fingerprint = createHash("sha256")
          .update(JSON.stringify({ format: settings.format, csv: settings.csv, columns: settings.columns }))
          .digest("hex")
          .slice(0, 12);
        await writeFile(statePath, JSON.stringify(state));
        const firstInactiveChange = {
          ...settings,
          csv: { ...settings.csv, fieldSeparator: "|" }
        };
        await settingsStore.save(firstInactiveChange);
        await settingsStore.save({
          ...firstInactiveChange,
          csv: { ...firstInactiveChange.csv, dateFormat: "dd/mm/yyyy" }
        });
      }

      const recoveryStatePath = `${config.exportSettingsPath}.state.json`;
      const priorState = await readFile(recoveryStatePath);
      addMovement("two", "Tea");
      const second = await exporter.export();
      const installedOutput = await readFile(second.path);
      const installedState = JSON.parse(await readFile(recoveryStatePath, "utf8")) as Record<string, unknown>;
      const recoveryTemporaryName = ".kakebo_movements.999.111.tmp";
      const pendingState = {
        state: installedState,
        settings,
        outputHash: createHash("sha256").update(installedOutput).digest("hex"),
        temporaryOutput: recoveryTemporaryName,
        rollbackOutput: `kakebo_movements.${format}.999.111.rollback`
      };
      await writeFile(`${recoveryStatePath}.pending`, JSON.stringify(pendingState));
      await writeFile(recoveryStatePath, priorState);
      const recovered = await exporter.export().then(() => true, () => false);
      if (!recovered) database.close();
      expect(recovered).toBe(true);
      await expect(access(`${recoveryStatePath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });

      const temporaryRecoveryOutput = await readFile(second.path);
      await writeFile(join(config.exportDirectory, pendingState.rollbackOutput), installedOutput);
      await rename(second.path, join(config.exportDirectory, recoveryTemporaryName));
      await writeFile(`${recoveryStatePath}.pending`, JSON.stringify({
        ...pendingState,
        outputHash: createHash("sha256").update(temporaryRecoveryOutput).digest("hex")
      }));
      await writeFile(recoveryStatePath, priorState);
      await exporter.export();
      await expect(access(join(config.exportDirectory, recoveryTemporaryName))).rejects.toMatchObject({ code: "ENOENT" });
      const clearedRollback = await access(join(config.exportDirectory, pendingState.rollbackOutput)).then(() => false, () => true);
      if (!clearedRollback) database.close();
      expect(clearedRollback).toBe(true);

      const recoveredOutput = await readFile(second.path);
      const recoveredState = await readFile(recoveryStatePath);
      let editedOutput: Uint8Array;
      if (format === "csv") {
        editedOutput = Buffer.from(recoveredOutput.toString("utf8").replace("Edited manual", "Recovered edit"));
      } else {
        const workbook = unzipSync(recoveredOutput);
        workbook["xl/sharedStrings.xml"] = Buffer.from(
          Buffer.from(workbook["xl/sharedStrings.xml"] ?? []).toString("utf8").replace("  Edited manual  ", "Recovered edit")
        );
        editedOutput = zipSync(workbook);
      }
      await writeFile(second.path, editedOutput);
      await writeFile(`${recoveryStatePath}.pending`, JSON.stringify({
        ...pendingState,
        outputHash: createHash("sha256").update(recoveredOutput).digest("hex")
      }));
      await writeFile(recoveryStatePath, priorState);
      const recoversEditedOutput = await exporter.export().then(() => true, () => false);
      if (!recoversEditedOutput) database.close();
      expect(recoversEditedOutput).toBe(true);
      if (format === "csv") expect(await readFile(second.path, "utf8")).toContain("Recovered edit");
      else expect((await readSheet(second.path)).flat()).toContain("Recovered edit");
      await writeFile(second.path, recoveredOutput);
      await writeFile(recoveryStatePath, recoveredState);

      await writeFile(`${recoveryStatePath}.pending`, JSON.stringify({
        ...pendingState,
        state: { ...installedState, movementKeys: ["movement-one"] },
        outputHash: "0".repeat(64)
      }));
      await writeFile(recoveryStatePath, priorState);
      const rejectsUnverifiedRecovery = await exporter.export().then(() => false, () => true);
      expect(rejectsUnverifiedRecovery).toBe(true);
      expect(await readFile(second.path)).toEqual(recoveredOutput);
      expect(await readFile(recoveryStatePath)).toEqual(priorState);
      await expect(access(`${recoveryStatePath}.pending`)).resolves.toBeUndefined();
      await rm(`${recoveryStatePath}.pending`);
      await writeFile(recoveryStatePath, recoveredState);
      const baselineSettings = await settingsStore.load();
      for (const changedHeader of [false, true]) {
        const changedSettings = {
          ...baselineSettings,
          columns: baselineSettings.columns.map((column) =>
            !("field" in column) && column.kind === "formula" && column.header === "Formula label"
              ? { ...column, formula: '"Updated formula"', header: changedHeader ? "Changed formula header" : column.header }
              : column
          )
        };
        await settingsStore.save(changedSettings);
        await exporter.export();
        const changedOutput = await readFile(second.path);
        const changedState = JSON.parse(await readFile(recoveryStatePath, "utf8")) as Record<string, unknown>;
        await writeFile(second.path, recoveredOutput);
        await writeFile(recoveryStatePath, recoveredState);
        await writeFile(join(config.exportDirectory, recoveryTemporaryName), changedOutput);
        await writeFile(`${recoveryStatePath}.pending`, JSON.stringify({
          ...pendingState,
          settings: changedSettings,
          state: changedState,
          outputHash: createHash("sha256").update(changedOutput).digest("hex")
        }));
        await exporter.export();
        if (format === "csv") expect(await readFile(second.path, "utf8")).toContain("Updated formula");
        else expect((await readSheet(second.path)).flat()).toContain("Updated formula");
        await expect(access(join(config.exportDirectory, recoveryTemporaryName))).rejects.toMatchObject({ code: "ENOENT" });
        await settingsStore.save(baselineSettings);
        await writeFile(second.path, recoveredOutput);
        await writeFile(recoveryStatePath, recoveredState);
      }
      const rejectedCustomEdits: boolean[] = [];
      if (format === "csv") {
        const rows = (await readFile(second.path, "utf8"))
          .replace(/^\uFEFF/u, "")
          .trim()
          .split(/\r?\n/u)
          .map((line) => line.split(";"));
        const header = rows[0] ?? [];
        const formulaIndex = header.indexOf("Formula label");
        const manualIndex = header.indexOf("Manual note");
        const movementIndex = header.indexOf("MovementKey");
        const tinyNumberIndex = header.indexOf("Tiny number");
        const values = new Map(rows.slice(1).map((row) => [row[movementIndex], row]));
        expect(values.get("movement-one")?.[formulaIndex]).toBe("Edited formula");
        expect(values.get("movement-one")?.[manualIndex]).toBe("Edited manual");
        expect(values.get("movement-two")?.[formulaIndex]).toBe("'=TEA");
        expect(values.get("movement-two")?.[manualIndex]).toBe("");
        expect(values.get("movement-two")?.[tinyNumberIndex]).toMatch(/^-\d+(?:,\d+)?e-\d+$/u);
        const validCsv = await readFile(second.path, "utf8");
        const withBlankRows = validCsv.replace(/\r\n/u, "\r\n\r\n") + "\r\n";
        await writeFile(second.path, withBlankRows);
        const acceptsBlankRows = await exporter.export().then(() => true, () => false);
        if (!acceptsBlankRows) database.close();
        expect(acceptsBlankRows).toBe(true);
        expect(await readFile(second.path, "utf8")).toContain("Edited manual");
        const statePath = `${config.exportSettingsPath}.state.json`;
        const validState = await readFile(statePath);
        const invalidCsvFiles = [
          validCsv.replace("Edited manual", '5" screen"'),
          (() => {
            const lines = validCsv.trimEnd().split(/\r?\n/u);
            lines.splice(2, 0, lines[1] ?? "");
            return `${lines.join("\r\n")}\r\n`;
          })(),
          (() => {
            const lines = validCsv.trimEnd().split(/\r?\n/u);
            lines[1] = (lines[1] ?? "").split(";").slice(0, -1).join(";");
            return `${lines.join("\r\n")}\r\n`;
          })(),
          (() => {
            const lines = validCsv.trimEnd().split(/\r?\n/u);
            lines[0] = (lines[0] ?? "").replace("MovementKey", "Edited movement key");
            return `${lines.join("\r\n")}\r\n`;
          })(),
          (() => {
            const lines = validCsv.trimEnd().split(/\r?\n/u);
            const row = (lines[1] ?? "").split(";");
            row[movementIndex] = "unknown-movement-key";
            row[manualIndex] = "Latest manual edit";
            lines[1] = row.join(";");
            return `${lines.join("\r\n")}\r\n`;
          })(),
          '"unterminated'
        ];
        for (const invalidCsv of invalidCsvFiles) {
          await writeFile(second.path, invalidCsv);
          const rejected = await exporter.export().then(() => false, () => true);
          const unchanged = await readFile(second.path, "utf8").then((content) => content === invalidCsv);
          rejectedCustomEdits.push(rejected && unchanged);
          await writeFile(second.path, validCsv);
          await writeFile(statePath, validState);
        }
        const latestCsv = Buffer.from(validCsv.replace("Edited manual", "Latest manual edit"), "utf8");
        const latestManualIndex = latestCsv.indexOf(Buffer.from("Latest manual edit", "utf8"));
        expect(latestManualIndex).toBeGreaterThanOrEqual(0);
        const invalidUtf8Csv = Buffer.concat([
          latestCsv.subarray(0, latestManualIndex),
          Buffer.from([0xff]),
          latestCsv.subarray(latestManualIndex + 1)
        ]);
        await writeFile(second.path, invalidUtf8Csv);
        const rejectedInvalidUtf8 = await exporter.export().then(() => false, () => true);
        const unchangedInvalidUtf8 = Buffer.compare(await readFile(second.path), invalidUtf8Csv) === 0;
        rejectedCustomEdits.push(rejectedInvalidUtf8 && unchangedInvalidUtf8);
        await writeFile(second.path, validCsv);
        await writeFile(statePath, validState);
      } else {
        const rows = await readSheet(second.path, { trim: false });
        const header = rows[0]?.map(String) ?? [];
        const formulaIndex = header.indexOf("Formula label");
        const manualIndex = header.indexOf("Manual note");
        const movementIndex = header.indexOf("MovementKey");
        const values = new Map(rows.slice(1).map((row) => [String(row[movementIndex]), row]));
        expect(values.get("movement-one")?.[formulaIndex]).toBe("Edited formula");
        expect(values.get("movement-one")?.[manualIndex]).toBe("  Edited manual  ");
        expect(values.get("movement-two")?.[formulaIndex]).toBe("=TEA");
        expect(values.get("movement-two")?.[manualIndex]).toBeNull();
        const statePath = `${config.exportSettingsPath}.state.json`;
        const validOutput = await readFile(second.path);
        const validState = await readFile(statePath);
        const verifyRejectedXlsxFile = async (): Promise<void> => {
          const malformedOutput = await readFile(second.path);
          const rejected = await exporter.export().then(() => false, () => true);
          const unchanged = Buffer.compare(await readFile(second.path), malformedOutput) === 0;
          rejectedCustomEdits.push(rejected && unchanged);
          await writeFile(second.path, validOutput);
          await writeFile(statePath, validState);
        };
        const verifyRejectedXlsx = async (
          data: SheetData,
          sheet = "Movements"
        ): Promise<void> => {
          await writeXlsxFile(data, { sheet }).toFile(second.path);
          await verifyRejectedXlsxFile();
        };
        const rowsForEditing = await readSheet(second.path, "Movements", { trim: false });
        const toSheetData = (): SheetData => rowsForEditing.map((row) => row.map((value) => ({
          value: String(value ?? ""),
          type: String
        })));
        const changedHeader = toSheetData();
        const headerRow = changedHeader[0];
        if (headerRow) headerRow[0] = { value: "Modified movement key", type: String };
        await verifyRejectedXlsx(changedHeader);
        await verifyRejectedXlsx(toSheetData(), "Renamed movements");
        const duplicateKey = toSheetData();
        duplicateKey.splice(2, 0, duplicateKey[1] ?? []);
        await verifyRejectedXlsx(duplicateKey);
        const blankMovementKey = toSheetData();
        const blankMovementRow = blankMovementKey[1];
        if (blankMovementRow) blankMovementRow[movementIndex] = { value: "", type: String };
        await verifyRejectedXlsx(blankMovementKey);
        const nonStringMovementKey = toSheetData();
        const nonStringMovementRow = nonStringMovementKey[1];
        if (nonStringMovementRow) nonStringMovementRow[movementIndex] = { value: 42, type: Number };
        await verifyRejectedXlsx(nonStringMovementKey);
        const unknownMovementKey = toSheetData();
        const unknownMovementRow = unknownMovementKey[1];
        if (unknownMovementRow) {
          unknownMovementRow[movementIndex] = { value: "unknown-movement-key", type: String };
          unknownMovementRow[manualIndex] = { value: "Latest manual edit", type: String };
        }
        await verifyRejectedXlsx(unknownMovementKey);

        const columnLetters = (index: number): string => {
          let value = index + 1;
          let letters = "";
          while (value > 0) {
            value -= 1;
            letters = String.fromCharCode(65 + (value % 26)) + letters;
            value = Math.floor(value / 26);
          }
          return letters;
        };
        const manualCell = `${columnLetters(manualIndex)}2`;
        const impreciseWorkbook = unzipSync(validOutput);
        const worksheet = Buffer.from(impreciseWorkbook["xl/worksheets/sheet1.xml"] ?? []).toString("utf8");
        const cellPattern = new RegExp(`<c\\b[^>]*\\br="${manualCell}"[^>]*>[\\s\\S]*?<\\/c>`, "u");
        const stringCell = worksheet.match(cellPattern)?.[0];
        expect(stringCell).toBeDefined();
        const numericCell = stringCell
          ?.replace(/\s+t="s"/u, "")
          .replace(/<v>[^<]*<\/v>/u, "<v>72561318574551.59</v>");
        expect(numericCell).not.toBe(stringCell);
        const impreciseWorksheet = worksheet.replace(cellPattern, numericCell ?? "");
        expect(impreciseWorksheet).not.toBe(worksheet);
        impreciseWorkbook["xl/worksheets/sheet1.xml"] = Buffer.from(impreciseWorksheet);
        await writeFile(second.path, zipSync(impreciseWorkbook));
        const lossyNumericRows = await readSheet(second.path, "Movements", { trim: false });
        expect(lossyNumericRows[1]?.[manualIndex]).toBe(72561318574551.6);
        await verifyRejectedXlsxFile();

        const workbook = unzipSync(await readFile(second.path));
        const styles = Buffer.from(workbook["xl/styles.xml"] ?? []).toString("utf8");
        expect(styles).not.toContain("#,##0.###############");
      }
      database.close();
      if (format === "csv") expect(rejectedCustomEdits).toEqual([true, true, true, true, true, true, true]);
      else expect(rejectedCustomEdits).toEqual([true, true, true, true, true, true, true]);
    }
  );

  it.each(["csv", "xlsx"] as const)("recovers resaved noncustom %s exports without movement keys", async (format) => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-keyless-recovery-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = format;
    settings.columns = settings.columns.map((column) =>
      "field" in column && column.field === "movementKey" ? { ...column, enabled: false } : column
    );
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
    const exporter = new CsvExporter(config, database);
    const output = await exporter.export();
    const statePath = `${config.exportSettingsPath}.state.json`;
    const original = await readFile(output.path);
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(`${statePath}.pending`, JSON.stringify({
      state, settings,
      outputHash: createHash("sha256").update(original).digest("hex"),
      temporaryOutput: ".kakebo_movements.999.111.tmp"
    }));
    if (format === "csv") await writeFile(output.path, Buffer.concat([original, Buffer.from("\r\n")]));
    else await writeXlsxFile([
      settings.columns.filter((column) => column.enabled).map((column) => ({ value: column.header, type: String }))
    ], { sheet: "Movements" }).toFile(output.path);
    const recovered = await exporter.export().then(() => true, () => false);
    database.close();
    expect(recovered).toBe(true);
    await expect(access(`${statePath}.pending`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows an unsafe amount when a formula only mentions it in a string literal", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-formula-literal-"));
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
           bank_connection_id, account_id, status, booking_date, amount, currency,
           direction, description_raw, description_normalized, reviewed,
           first_seen_at, last_seen_at, imported_at, raw_fingerprint
         ) VALUES (
           'transaction', 'movement', 'reconcile', 'enable-banking', 'sandbox',
           'connection', 'account', 'booked', '2026-09-01', '72561318574551.59',
           'EUR', 'income', 'Coffee', 'COFFEE', 0, ?, ?, ?, 'raw'
         )`
      )
      .run(now, now, now);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    settings.columns.push({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "formula",
      header: "Literal",
      enabled: true,
      formula: 'concat("amount: ", description)'
    }, {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "formula",
      header: "Coalesced",
      enabled: true,
      formula: "coalesce(description, amount)"
    });
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);

    const result = await new CsvExporter(config, database).export();

    await expect(readFile(result.path, "utf8")).resolves.toContain("amount: Coffee");
    await expect(readFile(result.path, "utf8")).resolves.toContain("Coffee");
    settings.columns.push({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "formula",
      header: "Amount copy",
      enabled: true,
      formula: "amount * 1"
    });
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
    await expect(new CsvExporter(config, database).export()).rejects.toThrow(
      "Kakebo Harvester could not generate the export file."
    );
    database.close();
  });

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
    expect(exactSpreadsheetNumber("72561318574551.59")).toBeNull();
    expect(exactSpreadsheetNumber("72561318574551.60")).toBeNull();
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
      writeFile(`${config.exportSettingsPath}.state.json`, "{}"),
      writeFile(`${config.exportSettingsPath}.state.json.pending`, "{}")
    ]);

    await expect(countGeneratedExportFiles(config)).resolves.toBe(1);
    await expect(clearGeneratedExportFiles(config)).resolves.toBe(1);
    await expect(readdir(config.exportDirectory)).resolves.toEqual([]);
    await expect(readFile(`${config.exportSettingsPath}.state.json`)).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(`${config.exportSettingsPath}.state.json.pending`)).rejects.toMatchObject({ code: "ENOENT" });
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

  it.each(["csv", "xlsx"] as const)("preserves surviving annotations while purging deleted movements from %s", async (format) => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-purge-custom-"));
    const config = { ...testConfig(root), exportKeepBackup: true };
    const database = createDatabase(config.databasePath);
    try {
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO bank_connections (
        id, provider, environment, bank_name, bank_country, psu_type, alias, status, created_at
      ) VALUES ('connection', 'enable-banking', 'sandbox', 'Demo', 'ES', 'personal', 'Demo', 'AUTHORIZED', ?)`).run(now);
      database.prepare(`INSERT INTO accounts (
        id, bank_connection_id, provider_account_id, name, active, first_seen_at, last_seen_at
      ) VALUES ('account', 'connection', 'provider', 'Account', 1, ?, ?)`).run(now, now);
      const insert = database.prepare(`INSERT INTO transactions (
        id, movement_key, reconciliation_key, provider, environment, bank_connection_id,
        account_id, status, booking_date, amount, currency, direction, description_raw,
        description_normalized, reviewed, first_seen_at, last_seen_at, imported_at, raw_fingerprint
      ) VALUES (?, ?, ?, 'enable-banking', 'sandbox', 'connection', 'account', 'booked',
        '2026-09-01', '-12.34', 'EUR', 'expense', 'Coffee', 'COFFEE', 0, ?, ?, ?, ?)`);
      for (const id of ["survivor", "deleted"]) insert.run(id, id, id, now, now, now, id);
      const settings = createDefaultExportSettings(",", ";");
      settings.format = format;
      const manualId = "22222222-2222-4222-8222-222222222222";
      settings.columns.push({ id: manualId, kind: "manual", header: "Manual note", enabled: true });
      await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
      const exporter = new CsvExporter(config, database);
      const first = await exporter.export();
      if (format === "csv") {
        const lines = (await readFile(first.path, "utf8")).replace(/^\uFEFF/u, "").trim().split(/\r?\n/u);
        const header = lines[0]?.split(";") ?? [];
        for (let index = 1; index < lines.length; index++) {
          const cells = (lines[index] ?? "").split(";");
          cells[header.indexOf("Manual note")] = cells[header.indexOf("MovementKey")] === "deleted" ? "Private deleted note" : "Surviving edit";
          lines[index] = cells.join(";");
        }
        await writeFile(first.path, `${lines.join("\r\n")}\r\n`);
      } else {
        const headers = settings.columns.filter((column) => column.enabled);
        const data: SheetData = [headers.map((column) => ({ value: column.header, type: String }))];
        for (const id of ["survivor", "deleted"]) data.push(headers.map((column) => ({
          value: "field" in column ? column.field === "movementKey" ? id : "source value" : id === "deleted" ? "Private deleted note" : "Surviving edit",
          type: String
        })));
        await writeXlsxFile(data, { sheet: "Movements" }).toFile(first.path);
      }
      // Persist both annotations, then make a further edit only in the user's file.
      await exporter.export();
      const statePath = `${config.exportSettingsPath}.state.json`;
      const priorState = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      await writeFile(statePath, JSON.stringify({
        ...priorState,
        sourceMovementKeys: { banking: ["deleted"], cards: [] },
        highlightedMovementKeys: { banking: ["survivor"], cards: [] }
      }));
      if (format === "csv") await writeFile(first.path, (await readFile(first.path, "utf8")).replace("Surviving edit", "Latest surviving edit"));
      else {
        const workbook = unzipSync(await readFile(first.path));
        workbook["xl/sharedStrings.xml"] = Buffer.from(Buffer.from(workbook["xl/sharedStrings.xml"] ?? []).toString("utf8").replace("Surviving edit", "Latest surviving edit"));
        await writeFile(first.path, zipSync(workbook));
      }
      await rm(join(config.exportDirectory, "archive"), { recursive: true, force: true });
      database.prepare("DELETE FROM transactions WHERE id = 'deleted'").run();
      await exporter.export({ discardPreviousOutput: true, highlightSource: "banking" });
      const values = format === "csv" ? await readFile(first.path, "utf8") : (await readSheet(first.path)).flat();
      expect(values).toContain("Latest surviving edit");
      expect(values).not.toContain("Private deleted note");
      const state = JSON.parse(await readFile(`${config.exportSettingsPath}.state.json`, "utf8")) as Record<string, unknown>;
      expect(state.customValues).toEqual({ survivor: { [manualId]: "Latest surviving edit" } });
      expect(state.sourceMovementKeys).toEqual({ banking: ["survivor"], cards: [] });
      expect(state.highlightedMovementKeys).toEqual({ banking: [], cards: [] });
      expect(await readdir(config.exportDirectory)).toEqual([`kakebo_movements.${format}`]);
    } finally {
      database.close();
    }
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

  it("refuses a privacy purge regeneration through a linked export directory", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-purge-linked-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
    const linkedTarget = join(root, "linked-export-target");
    await mkdir(linkedTarget, { recursive: true });
    await writeFile(join(linkedTarget, "kakebo_movements.csv"), "must remain");
    await symlink(linkedTarget, config.exportDirectory, "junction");

    await expect(
      new CsvExporter(config, database).export({ discardPreviousOutput: true })
    ).rejects.toThrow("Kakebo Harvester could not generate the export file.");
    await expect(
      readFile(join(linkedTarget, "kakebo_movements.csv"), "utf8")
    ).resolves.toBe("must remain");
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
    await expect(access(`${config.exportSettingsPath}.state.json.pending`)).rejects.toMatchObject({ code: "ENOENT" });
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
