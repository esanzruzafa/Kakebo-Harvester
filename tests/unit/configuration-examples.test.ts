import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cardImportProfileSchema } from "../../src/settings/card-import-profiles-store.js";
import { validateCategories } from "../../src/settings/categories-store.js";
import { validateCategorizationConfiguration } from "../../src/settings/categorization-rules-store.js";
import { exportSettingsSchema } from "../../src/settings/export-settings-store.js";

const repositoryRoot = process.cwd();

async function readExample(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(repositoryRoot, "config", name), "utf8")
  ) as unknown;
}

describe("public configuration examples", () => {
  it("matches the generated account snapshot format", async () => {
    const snapshotSchema = z.object({
      version: z.literal(1),
      accounts: z.array(
        z.object({
          identificationHash: z.string().nullable(),
          bank: z.string(),
          account: z.string(),
          masked: z.string().nullable(),
          alias: z.string(),
          syncEnabled: z.boolean(),
          exportEnabled: z.boolean()
        })
      )
    });

    const example = await readExample("accounts.example.json");
    expect(() => snapshotSchema.parse(example)).not.toThrow();
  });

  it("passes the runtime validators for editable settings", async () => {
    const [categories, rules, exportSettings, cardProfiles, uiSettings] =
      await Promise.all([
        readExample("categories.example.json"),
        readExample("categorization-rules.example.json"),
        readExample("export-settings.example.json"),
        readExample("card-import-profiles.example.json"),
        readExample("ui-settings.example.json")
      ]);

    expect(() => validateCategories(categories)).not.toThrow();
    expect(() => validateCategorizationConfiguration(rules)).not.toThrow();
    expect(() => exportSettingsSchema.parse(exportSettings)).not.toThrow();
    expect(() =>
      z.array(cardImportProfileSchema).parse(cardProfiles)
    ).not.toThrow();
    expect(() =>
      z
        .object({
          language: z.enum(["en", "es"]),
          auditHistoryLimit: z.union([
            z.literal(5),
            z.literal(10),
            z.literal(20),
            z.literal(50),
            z.literal(100)
          ])
        })
        .parse(uiSettings)
    ).not.toThrow();
  });
});
