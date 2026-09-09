import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeXlsxFile, { type SheetData } from "write-excel-file/node";
import { afterEach, describe, expect, it } from "vitest";
import { CardImportService } from "../../src/cards/card-import-service.js";
import {
  CardImportProfilesStore,
  createDefaultCardImportProfiles,
  type CardImportProfile
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
  it("recognizes a one-row statement updated in place", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-updated-source-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const profiles = createDefaultCardImportProfiles();
    const profile = profiles[0];
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save(profiles);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "card-latest.xlsx");
    const original: [string, string, string, string] = [
      "20/06/2026",
      "Coffee shop",
      "20/06/2026",
      "-4,50"
    ];
    await writeXlsxFile(workbookRows([original])).toFile(statementPath);
    const importer = new CardImportService(config, database);

    const first = await importer.import({
      files: [{ path: statementPath, profileId: profile.id }]
    });
    await writeXlsxFile(workbookRows([original, original])).toFile(statementPath);
    const updated = await importer.import({
      files: [{ path: statementPath, profileId: profile.id }]
    });
    const repeated = await importer.import({
      files: [{ path: statementPath, profileId: profile.id }]
    });

    expect(first).toMatchObject({ rows: 1, inserted: 1, duplicates: 0 });
    expect(updated).toMatchObject({ rows: 2, inserted: 1, duplicates: 1 });
    expect(repeated).toMatchObject({ rows: 2, inserted: 0, duplicates: 2 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS total FROM transactions WHERE provider = 'manual-card'"
        )
        .get()
    ).toEqual({ total: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS total FROM card_import_source_rows").get()
    ).toEqual({ total: 2 });
    database.close();
  });

  it("preserves existing movements when a statement path is replaced without an anchor", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-corrected-source-row-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const profiles = createDefaultCardImportProfiles();
    const profile = profiles[0];
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save(profiles);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "card-corrected.xlsx");
    await writeXlsxFile(
      workbookRows([["20/06/2026", "Coffee shop", "20/06/2026", "-4,50"]])
    ).toFile(statementPath);
    const importer = new CardImportService(config, database);
    await importer.import({ files: [{ path: statementPath, profileId: profile.id }] });

    await writeXlsxFile(
      workbookRows([["21/06/2026", "Corrected coffee shop", "21/06/2026", "-5,00"]])
    ).toFile(statementPath);
    const replaced = await importer.import({
      files: [{ path: statementPath, profileId: profile.id }]
    });

    expect(replaced).toMatchObject({ rows: 1, updated: 0, inserted: 1 });
    expect(
      database
        .prepare(
          `SELECT booking_date, description_raw, amount
           FROM transactions WHERE provider = 'manual-card' ORDER BY booking_date`
        )
        .all()
    ).toEqual([
      {
        booking_date: "2026-06-20",
        description_raw: "Coffee shop",
        amount: "-4.5"
      },
      {
        booking_date: "2026-06-21",
        description_raw: "Corrected coffee shop",
        amount: "-5"
      }
    ]);
    database.close();
  });

  it("reuses the corrected row identity when two unchanged rows anchor an updated statement", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-anchored-correction-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const [profile] = createDefaultCardImportProfiles();
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save([profile]);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "card-corrected.xlsx");
    const firstAnchor: [string, string, string, string] = [
      "20/06/2026",
      "First anchor",
      "20/06/2026",
      "-1,00"
    ];
    const original: [string, string, string, string] = [
      "21/06/2026",
      "Original movement",
      "21/06/2026",
      "-2,00"
    ];
    const secondAnchor: [string, string, string, string] = [
      "22/06/2026",
      "Second anchor",
      "22/06/2026",
      "-3,00"
    ];
    await writeXlsxFile(workbookRows([firstAnchor, original, secondAnchor])).toFile(
      statementPath
    );
    const importer = new CardImportService(config, database);
    await importer.import({ files: [{ path: statementPath, profileId: profile.id }] });

    await writeXlsxFile(
      workbookRows([
        firstAnchor,
        ["21/06/2026", "Corrected movement", "21/06/2026", "-2,50"],
        secondAnchor
      ])
    ).toFile(statementPath);
    const updated = await importer.import({
      files: [{ path: statementPath, profileId: profile.id }]
    });

    expect(updated).toMatchObject({ inserted: 0, updated: 1, duplicates: 2 });
    expect(
      database
        .prepare(
          `SELECT description_raw, amount FROM transactions
           WHERE provider = 'manual-card' ORDER BY booking_date`
        )
        .all()
    ).toEqual([
      { description_raw: "First anchor", amount: "-1" },
      { description_raw: "Corrected movement", amount: "-2.5" },
      { description_raw: "Second anchor", amount: "-3" }
    ]);
    database.close();
  });

  it("keeps a new row inserted above an existing statement movement", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-inserted-source-row-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const profiles = createDefaultCardImportProfiles();
    const profile = profiles[0];
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save(profiles);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "card-inserted-row.xlsx");
    const original: [string, string, string, string] = [
      "20/06/2026",
      "Existing movement",
      "20/06/2026",
      "-4,50"
    ];
    await writeXlsxFile(workbookRows([original])).toFile(statementPath);
    const importer = new CardImportService(config, database);
    await importer.import({ files: [{ path: statementPath, profileId: profile.id }] });

    await writeXlsxFile(
      workbookRows([
        ["19/06/2026", "Inserted movement", "19/06/2026", "-3,00"],
        original
      ])
    ).toFile(statementPath);
    const updated = await importer.import({
      files: [{ path: statementPath, profileId: profile.id }]
    });

    expect(updated).toMatchObject({ rows: 2, inserted: 1, duplicates: 1 });
    expect(
      database
        .prepare(
          `SELECT description_raw FROM transactions
           WHERE provider = 'manual-card' ORDER BY booking_date`
        )
        .all()
    ).toEqual([
      { description_raw: "Inserted movement" },
      { description_raw: "Existing movement" }
    ]);
    database.close();
  });

  it("updates the stored local account labels when an imported card profile is renamed", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-profile-labels-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const profiles = createDefaultCardImportProfiles();
    const profile = profiles[0];
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save(profiles);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "card-labels.xlsx");
    await writeXlsxFile(
      workbookRows([["20/06/2026", "Coffee shop", "20/06/2026", "-4,50"]])
    ).toFile(statementPath);
    const importer = new CardImportService(config, database);
    await importer.import({ files: [{ path: statementPath, profileId: profile.id }] });

    importer.refreshStoredProfile({
      ...profile,
      bankName: "Renamed Bank",
      cardName: "Renamed Card"
    } satisfies CardImportProfile);

    expect(
      database
        .prepare(
          `SELECT c.bank_name, a.name, a.display_name
           FROM accounts a JOIN bank_connections c ON c.id = a.bank_connection_id
           WHERE a.provider_account_id = ?`
        )
        .get(profile.id)
    ).toEqual({
      bank_name: "Renamed Bank",
      name: "Renamed Card",
      display_name: "Renamed Card"
    });
    database.close();
  });

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

    await writeXlsxFile(
      workbookRows([
        ["20/06/2026", "Supermarket", "21/06/2026", "-12,34"],
        ["22/06/2026", "Book shop", "23/06/2026", "-8,50"],
        ["04/07/2026", "Bus", "04/07/2026", "-1,80"]
      ])
    ).toFile(firstPath);
    await expect(
      importer.import({ files: [{ path: firstPath, profileId: profile.id }] })
    ).resolves.toMatchObject({ rows: 3, inserted: 1, duplicates: 2 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS total
           FROM transactions
           WHERE provider = 'manual-card'`
        )
        .get()
    ).toEqual({ total: 4 });
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

  it("keeps native Excel dates on the workbook calendar day", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-native-date-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const profiles = createDefaultCardImportProfiles();
    const profile = profiles[0];
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save(profiles);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "native-dates.xlsx");
    const rows = workbookRows([]);
    rows.push([
      { value: new Date(2026, 6, 20), type: Date, format: "yyyy-mm-dd" },
      { value: "Native date purchase", type: String },
      { value: new Date(2026, 6, 21), type: Date, format: "yyyy-mm-dd" },
      { value: -4.5, type: Number }
    ]);
    await writeXlsxFile(rows).toFile(statementPath);

    await new CardImportService(config, database).import({
      files: [{ path: statementPath, profileId: profile.id }]
    });

    expect(
      database
        .prepare(
          `SELECT booking_date, value_date FROM transactions
           WHERE provider = 'manual-card'`
        )
        .get()
    ).toEqual({ booking_date: "2026-07-20", value_date: "2026-07-21" });
    database.close();
  });

  it("parses the configured currency code and symbol without EUR-specific rules", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-currency-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const [defaultProfile] = createDefaultCardImportProfiles();
    if (!defaultProfile) throw new Error("The default card profile is missing.");
    const profile = {
      ...defaultProfile,
      id: "usd-card-1",
      currency: "USD",
      decimalSeparator: "." as const
    };
    await new CardImportProfilesStore(config.cardImportProfilesPath).save([
      profile
    ]);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "usd-card.xlsx");
    await writeXlsxFile(
      workbookRows([
        ["20/07/2026", "Hotel", "21/07/2026", "-USD $1,234.56"]
      ])
    ).toFile(statementPath);

    await new CardImportService(config, database).import({
      files: [{ path: statementPath, profileId: profile.id }]
    });

    expect(
      database
        .prepare(
          `SELECT amount, currency FROM transactions
           WHERE provider = 'manual-card'`
        )
        .get()
    ).toEqual({ amount: "-1234.56", currency: "USD" });
    database.close();
  });

  it("rejects a single-separator amount when the profile decimal separator is automatic", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-ambiguous-amount-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const [defaultProfile] = createDefaultCardImportProfiles();
    if (!defaultProfile) throw new Error("The default card profile is missing.");
    const profile = { ...defaultProfile, decimalSeparator: "auto" as const };
    await new CardImportProfilesStore(config.cardImportProfilesPath).save([profile]);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "ambiguous-amount.xlsx");
    await writeXlsxFile(
      workbookRows([["20/07/2026", "Hotel", "21/07/2026", "1,234"]])
    ).toFile(statementPath);

    try {
      await expect(
        new CardImportService(config, database).import({
          files: [{ path: statementPath, profileId: profile.id }]
        })
      ).rejects.toThrow(/ambiguous/i);
    } finally {
      database.close();
    }
  });

  it("rejects an ambiguous text date when the profile date format is automatic", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-ambiguous-date-"));
    const config = testConfig(root);
    const database = createDatabase(config.databasePath);
    const [defaultProfile] = createDefaultCardImportProfiles();
    if (!defaultProfile) throw new Error("The default card profile is missing.");
    const profile = { ...defaultProfile, dateFormat: "auto" as const };
    await new CardImportProfilesStore(config.cardImportProfilesPath).save([profile]);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const statementPath = join(root, "ambiguous-date.xlsx");
    await writeXlsxFile(
      workbookRows([["03/04/2026", "Hotel", "03/04/2026", "-12,34"]])
    ).toFile(statementPath);

    try {
      await expect(
        new CardImportService(config, database).import({
          files: [{ path: statementPath, profileId: profile.id }]
        })
      ).rejects.toThrow(/ambiguous date/i);
    } finally {
      database.close();
    }
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

  it("rejects a multi-file import before retaining more rows than its request limit", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-card-request-row-limit-"));
    const config = { ...testConfig(root), maxCardImportRows: 1 };
    const database = createDatabase(config.databasePath);
    const [profile] = createDefaultCardImportProfiles();
    if (!profile) throw new Error("The default card profile is missing.");
    await new CardImportProfilesStore(config.cardImportProfilesPath).save([profile]);
    await new CategorizationRulesStore(config.categorizationRulesPath).save([]);
    const firstPath = join(root, "first.xlsx");
    const secondPath = join(root, "second.xlsx");
    await writeXlsxFile(
      workbookRows([["20/06/2026", "First movement", "20/06/2026", "-1,00"]])
    ).toFile(firstPath);
    await writeXlsxFile(
      workbookRows([["21/06/2026", "Second movement", "21/06/2026", "-2,00"]])
    ).toFile(secondPath);

    await expect(
      new CardImportService(config, database).import({
        files: [
          { path: firstPath, profileId: profile.id },
          { path: secondPath, profileId: profile.id }
        ]
      })
    ).rejects.toThrow("MAX_CARD_IMPORT_ROWS=1");
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({
      count: 0
    });
    database.close();
  });
});
