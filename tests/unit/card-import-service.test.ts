import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeXlsxFile, { type SheetData } from "write-excel-file/node";
import { afterEach, describe, expect, it } from "vitest";
import { CardImportService } from "../../src/cards/card-import-service.js";
import {
  CardImportProfilesStore,
  createDefaultCardImportProfiles
} from "../../src/settings/card-import-profiles-store.js";
import { CategorizationRulesStore } from "../../src/settings/categorization-rules-store.js";
import { createDatabase } from "../../src/storage/database.js";
import { AccountRepository } from "../../src/storage/repositories/account-repository.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function workbookRows(
  movements: Array<[string, string, string, string]>
): SheetData {
  return [
    [{ value: "Card statement", type: String }],
    [null],
    [null],
    [null],
    [null],
    [null],
    [null],
    [
      { value: "fecha", type: String },
      { value: "concepto", type: String },
      { value: "fecha valor", type: String },
      { value: "importe de la operación", type: String }
    ],
    ...movements.map(([date, description, valueDate, amount]) => [
      { value: date, type: String },
      { value: description, type: String },
      { value: valueDate, type: String },
      { value: amount, type: String }
    ])
  ];
}

describe("CardImportService", () => {
  it("deduplicates overlapping Kutxabank workbooks and categorizes new rows", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-import-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const profiles = createDefaultCardImportProfiles();
    const profile = profiles[0];
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save(profiles);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([
      {
        enabled: true,
        priority: 10,
        field: "descriptionNormalized",
        operator: "contains",
        value: "supermarket",
        category: "Food",
        subcategory: "Groceries"
      }
    ]);
    const firstPath = join(root, "card-june.xlsx");
    const secondPath = join(root, "card-june-july.xlsx");
    await writeXlsxFile(
      workbookRows([
        ["20/06/2026", "Supermarket", "21/06/2026", "-12,34"],
        ["22/06/2026", "Book shop", "23/06/2026", "-8,50"]
      ])
    ).toFile(firstPath);
    await writeXlsxFile(
      workbookRows([
        ["20/06/2026", "Supermarket", "21/06/2026", "-12,34"],
        ["22/06/2026", "Book shop", "23/06/2026", "-8,50"],
        ["02/07/2026", "Train", "03/07/2026", "-5,25"]
      ])
    ).toFile(secondPath);

    const importer = new CardImportService(config, database);
    const first = await importer.import({
      files: [{ path: firstPath, profileId: profile.id }]
    });
    const overlap = await importer.import({
      files: [{ path: secondPath, profileId: profile.id }]
    });
    const repeated = await importer.import({
      files: [{ path: secondPath, profileId: profile.id }]
    });

    expect(first).toMatchObject({ rows: 2, inserted: 2, duplicates: 0 });
    expect(overlap).toMatchObject({ rows: 3, inserted: 1, duplicates: 2 });
    expect(repeated).toMatchObject({ rows: 3, inserted: 0, duplicates: 3 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS total
           FROM transactions
           WHERE provider = 'manual-card'`
        )
        .get()
    ).toEqual({ total: 3 });
    expect(
      database
        .prepare(
          `SELECT category_auto, subcategory_auto
           FROM transactions
           WHERE description_raw = 'Supermarket'`
        )
        .get()
    ).toEqual({ category_auto: "Food", subcategory_auto: "Groceries" });
    expect(
      database
        .prepare(
          `SELECT c.provider, c.status, a.sync_enabled, a.export_enabled
           FROM accounts a
           JOIN bank_connections c ON c.id = a.bank_connection_id`
        )
        .get()
    ).toEqual({
      provider: "manual-card",
      status: "LOCAL",
      sync_enabled: 0,
      export_enabled: 1
    });
    expect(new AccountRepository(database).listActive()).toEqual([]);
    database.close();
  });

  it("uses a named sheet and a reusable custom column mapping", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-profile-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const [defaultProfile] = createDefaultCardImportProfiles();
    if (!defaultProfile) throw new Error("The default card profile is missing.");
    const profile = {
      ...defaultProfile,
      id: "bbva-card-1",
      name: "BBVA card 1",
      bankName: "BBVA",
      cardName: "Travel card",
      sheet: "Card transactions",
      startRow: 4,
      columns: {
        date: "C",
        description: "A",
        valueDate: "D",
        amount: "B"
      },
      decimalSeparator: "," as const,
      invertAmountSign: true
    };
    await new CardImportProfilesStore(config.cardImportProfilesPath).save([
      profile
    ]);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "bbva-card.xlsx");
    const cover: SheetData = [[{ value: "Card statement", type: String }]];
    const movements: SheetData = [
      [{ value: "Metadata", type: String }],
      [
        { value: "Description", type: String },
        { value: "Amount", type: String },
        { value: "Date", type: String },
        { value: "Value date", type: String }
      ],
      [null],
      [
        { value: "Hotel", type: String },
        { value: "1.234,56", type: String },
        { value: "20/07/2026", type: String },
        { value: "21/07/2026", type: String }
      ]
    ];
    await writeXlsxFile([
      { data: cover, sheet: "Cover" },
      { data: movements, sheet: "Card transactions" }
    ]).toFile(statementPath);

    const result = await new CardImportService(config, database).import({
      files: [{ path: statementPath, profileId: profile.id }]
    });

    expect(result).toMatchObject({ rows: 1, inserted: 1, duplicates: 0 });
    expect(
      database
        .prepare(
          `SELECT description_raw, booking_date, value_date, amount, direction
           FROM transactions
           WHERE provider = 'manual-card'`
        )
        .get()
    ).toEqual({
      description_raw: "Hotel",
      booking_date: "2026-07-20",
      value_date: "2026-07-21",
      amount: "-1234.56",
      direction: "expense"
    });
    database.close();
  });

  it("keeps an ambiguous identical purchase from a separate statement", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-identical-statements-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const profiles = createDefaultCardImportProfiles();
    const profile = profiles[0];
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save(profiles);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const firstPath = join(root, "statement-one.xlsx");
    const secondPath = join(root, "statement-two.xlsx");
    const identical: [string, string, string, string] = [
      "20/08/2026",
      "Coffee shop",
      "20/08/2026",
      "-4,50"
    ];
    await writeXlsxFile(
      workbookRows([
        identical,
        ["19/08/2026", "Statement one anchor", "19/08/2026", "-1,00"]
      ])
    ).toFile(firstPath);
    await writeXlsxFile(
      workbookRows([
        identical,
        ["21/08/2026", "Statement two anchor", "21/08/2026", "-2,00"]
      ])
    ).toFile(secondPath);
    const importer = new CardImportService(config, database);

    await expect(
      importer.import({ files: [{ path: firstPath, profileId: profile.id }] })
    ).resolves.toMatchObject({ inserted: 2, duplicates: 0 });
    await expect(
      importer.import({ files: [{ path: secondPath, profileId: profile.id }] })
    ).resolves.toMatchObject({ inserted: 2, duplicates: 0 });
    await expect(
      importer.import({ files: [{ path: secondPath, profileId: profile.id }] })
    ).resolves.toMatchObject({ inserted: 0, duplicates: 2 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM transactions
           WHERE provider = 'manual-card' AND description_raw = 'Coffee shop'`
        )
        .get()
    ).toEqual({ count: 2 });
    database.close();
  });
});
