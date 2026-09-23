import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExportSettingsStore,
  createDefaultExportSettings,
  exportSettingsFingerprint,
  exportSettingsFingerprintCandidates,
  type ExportSettings
} from "../../src/settings/export-settings-store.js";
import { exportSettingsSchema } from "../../src/settings/export-settings-store.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("export settings custom columns", () => {
  it("migrates legacy profiles to schema version 2", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-settings-"));
    const path = join(root, "export-settings.json");
    const defaults = createDefaultExportSettings(".");
    const legacy = { ...defaults };
    delete legacy.schemaVersion;
    await writeFile(path, JSON.stringify(legacy));

    const loaded = await new ExportSettingsStore(path, defaults).load();

    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.columns).toEqual(defaults.columns);
    const legacyFingerprint = createHash("sha256")
      .update(JSON.stringify(legacy))
      .digest("hex")
      .slice(0, 12);
    expect(exportSettingsFingerprintCandidates(loaded)).toContain(legacyFingerprint);
  });

  it("requires one enabled movement key when an enabled custom column is present", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-export-settings-"));
    const path = join(root, "export-settings.json");
    const settings = createDefaultExportSettings(".");
    const movementKey = settings.columns.find(
      (column) => "field" in column && column.field === "movementKey"
    );
    if (!movementKey) throw new Error("Missing default movementKey column.");
    settings.columns = [
      ...settings.columns.map((column) =>
        column === movementKey ? { ...column, enabled: false } : column
      ),
      {
        id: "0c7e2ec6-5c09-4a6f-9c09-b21368b64a43",
        kind: "formula",
        header: "Double amount",
        enabled: true,
        formula: "amount * 2"
      }
    ];

    expect(() => exportSettingsSchema.parse(settings)).toThrow(/movementKey/i);
    await expect(new ExportSettingsStore(path, settings).save(settings)).rejects.toThrow(
      /not valid/i
    );
  });

  it("ignores inactive-format options and disabled columns in export fingerprints", () => {
    const settings = createDefaultExportSettings(".");
    settings.format = "xlsx";
    settings.columns = settings.columns.map((column, index) =>
      index === 0 ? { ...column, enabled: false } : column
    );
    const changed: ExportSettings = {
      ...settings,
      csv: { ...settings.csv, fieldSeparator: ";" },
      columns: settings.columns.map((column, index) =>
        index === 0 ? { ...column, header: "Ignored disabled column" } : column
      )
    };

    expect(exportSettingsFingerprint(changed)).toBe(exportSettingsFingerprint(settings));
  });

  it("accepts the legacy fingerprint from settings before an inactive option changed", () => {
    const previous = createDefaultExportSettings(",", ";");
    previous.format = "xlsx";
    const changed: ExportSettings = {
      ...previous,
      csv: { ...previous.csv, fieldSeparator: "|" }
    };
    const legacyFingerprint = createHash("sha256")
      .update(JSON.stringify({ format: previous.format, csv: previous.csv, columns: previous.columns }))
      .digest("hex")
      .slice(0, 12);

    expect(exportSettingsFingerprintCandidates(changed, previous)).toContain(legacyFingerprint);
  });
});
