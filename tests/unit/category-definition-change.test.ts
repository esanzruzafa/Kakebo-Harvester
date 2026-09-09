import { describe, expect, it } from "vitest";
import {
  applyCategoryDefinitionChange,
  removeCategoryDefinition
} from "../../src/desktop/category-definition-change.js";

describe("applyCategoryDefinitionChange", () => {
  it("propagates a renamed category and clears removed subcategory references", () => {
    const result = applyCategoryDefinitionChange({
      categories: [
        { name: "Food", subcategories: ["Groceries", "Restaurants"] },
        { name: "Home", subcategories: ["Rent"] }
      ],
      rules: [
        {
          enabled: true,
          priority: 10,
          field: "descriptionNormalized",
          operator: "contains",
          value: "MARKET",
          category: "Food",
          subcategory: "Groceries"
        },
        {
          enabled: true,
          priority: 20,
          field: "descriptionNormalized",
          operator: "contains",
          value: "RENT",
          category: "Home",
          subcategory: "Rent"
        }
      ],
      index: 0,
      replacement: { name: "Meals", subcategories: ["Restaurants"] }
    });

    expect(result.categories[0]).toEqual({
      name: "Meals",
      subcategories: ["Restaurants"]
    });
    expect(result.rules).toEqual([
      {
        enabled: true,
        priority: 10,
        field: "descriptionNormalized",
        operator: "contains",
        value: "MARKET",
        category: "Meals"
      },
      {
        enabled: true,
        priority: 20,
        field: "descriptionNormalized",
        operator: "contains",
        value: "RENT",
        category: "Home",
        subcategory: "Rent"
      }
    ]);
  });

  it("clears dependent selections when a category is removed", () => {
    const result = removeCategoryDefinition({
      categories: [
        { name: "Food", subcategories: ["Groceries"] },
        { name: "Home", subcategories: ["Rent"] }
      ],
      rules: [
        {
          enabled: true,
          priority: 10,
          field: "descriptionNormalized",
          operator: "contains",
          value: "MARKET",
          category: "Food",
          subcategory: "Groceries"
        }
      ],
      index: 0
    });

    expect(result.categories).toEqual([
      { name: "Home", subcategories: ["Rent"] }
    ]);
    expect(result.rules).toEqual([
      {
        enabled: true,
        priority: 10,
        field: "descriptionNormalized",
        operator: "contains",
        value: "MARKET",
        category: ""
      }
    ]);
  });
});
