import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Categorizer } from "../../src/transactions/categorization.js";

let rulesPath: string | undefined;

afterEach(async () => {
  if (rulesPath) await rm(rulesPath, { force: true });
  rulesPath = undefined;
});

describe("Categorizer", () => {
  it("does not auto-categorize Amazon or Bizum descriptions", async () => {
    rulesPath = join(tmpdir(), `kakebo-rules-${randomUUID()}.json`);
    await writeFile(
      rulesPath,
      JSON.stringify({
        exclusions: [
          {
            enabled: true,
            priority: 10,
            field: "descriptionNormalized",
            operator: "contains",
            value: "AMAZON"
          },
          {
            enabled: true,
            priority: 20,
            field: "descriptionNormalized",
            operator: "contains",
            value: "BIZUM"
          }
        ],
        rules: [
          {
          enabled: true,
          priority: 10,
          field: "descriptionNormalized",
          operator: "contains",
          value: "PISAMONAS",
          category: "Niños",
          subcategory: "Ropa"
          }
        ]
      })
    );
    const categorizer = new Categorizer(rulesPath);

    expect(categorizer.categorize("COMPRA EN PISAMONAS")).toEqual({
      category: "Niños",
      subcategory: "Ropa"
    });
    expect(categorizer.categorize("COMPRA BIZUM PISAMONAS")).toEqual({
      category: null,
      subcategory: null
    });
    expect(categorizer.categorize("COMPRA EN AMAZON PISAMONAS")).toEqual({
      category: null,
      subcategory: null
    });
  });
});
