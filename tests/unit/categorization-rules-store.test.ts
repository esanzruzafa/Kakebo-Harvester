import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { CategorizationRulesStore } from "../../src/settings/categorization-rules-store.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("categorization rule settings", () => {
  it("validates, orders and saves rules atomically", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-rules-"));
    const path = join(root, "config", "rules.json");
    const store = new CategorizationRulesStore(path);

    const saved = await store.save([
      {
        enabled: true,
        priority: 20,
        field: "descriptionNormalized",
        operator: "contains",
        value: "POWER",
        category: "Home"
      },
      {
        enabled: false,
        priority: 10,
        field: "descriptionNormalized",
        operator: "regex",
        value: "^SHOP",
        category: "Food",
        subcategory: "Groceries"
      }
    ]);

    expect(saved.map((rule) => rule.priority)).toEqual([10, 20]);
    expect(await store.load()).toEqual(saved);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(2);
  });

  it("rejects invalid regular expressions and duplicate priorities", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-rules-"));
    const store = new CategorizationRulesStore(join(root, "rules.json"));
    const base = {
      enabled: true,
      priority: 10,
      field: "descriptionNormalized" as const,
      operator: "regex" as const,
      value: "[",
      category: "Other"
    };

    await expect(store.save([base])).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      store.save([
        { ...base, operator: "contains", value: "ONE" },
        { ...base, operator: "contains", value: "TWO" }
      ])
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
