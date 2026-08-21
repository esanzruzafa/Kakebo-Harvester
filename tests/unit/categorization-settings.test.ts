import { describe, expect, it, vi } from "vitest";
import { saveCategorizationSettings } from "../../src/desktop/categorization-settings.js";
import type { CategoryDefinition } from "../../src/settings/categories-store.js";
import type { CategorizationConfiguration } from "../../src/settings/categorization-rules-store.js";

const previousCategories: CategoryDefinition[] = [
  { name: "Existing", subcategories: ["Previous"] }
];
const previousConfiguration: CategorizationConfiguration = {
  exclusions: [],
  rules: []
};

describe("categorization settings", () => {
  it("validates category references before writing either file", async () => {
    const saveCategories = vi.fn();
    const saveRules = vi.fn();
    await expect(
      saveCategorizationSettings(
        { load: vi.fn().mockResolvedValue(previousCategories), save: saveCategories },
        {
          loadConfiguration: vi.fn().mockResolvedValue(previousConfiguration),
          saveConfiguration: saveRules
        },
        {
          categories: [{ name: "Food", subcategories: [] }],
          exclusions: [],
          rules: [
            {
              enabled: true,
              priority: 0,
              field: "descriptionNormalized",
              operator: "contains",
              value: "PAYMENT",
              category: "Unknown"
            }
          ]
        }
      )
    ).rejects.toThrow("unknown category");
    expect(saveCategories).not.toHaveBeenCalled();
    expect(saveRules).not.toHaveBeenCalled();
  });

  it("rolls both files back when the second save fails", async () => {
    const nextCategories: CategoryDefinition[] = [
      { name: "Food", subcategories: ["Groceries"] }
    ];
    const nextConfiguration: CategorizationConfiguration = {
      exclusions: [],
      rules: [
        {
          enabled: true,
          priority: 0,
          field: "descriptionNormalized",
          operator: "contains",
          value: "MARKET",
          category: "Food",
          subcategory: "Groceries"
        }
      ]
    };
    const saveCategories = vi.fn((value: CategoryDefinition[]) =>
      Promise.resolve(value)
    );
    let firstRulesSave = true;
    const saveRules = vi.fn(
      (value: CategorizationConfiguration) => {
        if (firstRulesSave) {
          firstRulesSave = false;
          return Promise.reject(new Error("Disk full."));
        }
        return Promise.resolve(value);
      }
    );

    await expect(
      saveCategorizationSettings(
        { load: vi.fn().mockResolvedValue(previousCategories), save: saveCategories },
        {
          loadConfiguration: vi.fn().mockResolvedValue(previousConfiguration),
          saveConfiguration: saveRules
        },
        { categories: nextCategories, ...nextConfiguration }
      )
    ).rejects.toThrow("Disk full.");
    expect(saveCategories).toHaveBeenNthCalledWith(1, nextCategories);
    expect(saveCategories).toHaveBeenNthCalledWith(2, previousCategories);
    expect(saveRules).toHaveBeenNthCalledWith(1, nextConfiguration);
    expect(saveRules).toHaveBeenNthCalledWith(2, previousConfiguration);
  });
});
