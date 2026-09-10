import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CategoriesStore } from "../../src/settings/categories-store.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("categories store", () => {
  it("persists category and subcategory dependencies", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-categories-"));
    const store = new CategoriesStore(join(root, "config", "categories.json"));
    await store.save([
      { name: "Food", subcategories: ["Groceries", "Restaurants"] }
    ]);
    await expect(store.load()).resolves.toEqual([
      { name: "Food", subcategories: ["Groceries", "Restaurants"] }
    ]);
  });

  it("rejects duplicate category names", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-categories-"));
    const store = new CategoriesStore(join(root, "categories.json"));
    await expect(
      store.save([
        { name: "Food", subcategories: [] },
        { name: "food", subcategories: [] }
      ])
    ).rejects.toThrow("category dependencies");
  });
});
