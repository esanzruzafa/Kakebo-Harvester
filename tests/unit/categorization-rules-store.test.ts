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

    const saved = await store.saveConfiguration({
      exclusions: [
        {
          enabled: true,
          priority: 10,
          field: "descriptionNormalized",
          operator: "contains",
          value: "AMAZON"
        }
      ],
      rules: [
        {
        enabled: true,
        priority: 10,
        field: "descriptionNormalized",
        operator: "contains",
        value: "POWER",
        category: "Home"
      },
        {
        enabled: false,
        priority: 20,
        field: "descriptionNormalized",
        operator: "regex",
        value: "^SHOP",
        category: "Food",
        subcategory: "Groceries"
        }
      ]
    });

    expect(saved.rules.map((rule) => rule.priority)).toEqual([10, 20]);
    expect(saved.exclusions.map((exclusion) => exclusion.value)).toEqual([
      "AMAZON"
    ]);
    expect(await store.loadConfiguration()).toEqual(saved);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      exclusions: [{ value: "AMAZON" }],
      rules: [{ value: "POWER" }, { value: "^SHOP" }]
    });
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
      store.saveConfiguration({
        exclusions: [],
        rules: [
          { ...base, operator: "contains", value: "ONE" },
          { ...base, operator: "contains", value: "TWO" }
        ]
      })
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("rejects a regex with nested quantifiers that can block categorization", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-rules-"));
    const store = new CategorizationRulesStore(join(root, "rules.json"));

    await expect(
      store.save([
        {
          enabled: true,
          priority: 10,
          field: "descriptionNormalized",
          operator: "regex",
          value: "^(a+)+$",
          category: "Other"
        }
      ])
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("normalizes a blank optional subcategory to no subcategory", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-rules-"));
    const store = new CategorizationRulesStore(join(root, "rules.json"));

    const saved = await store.save([
      {
        enabled: true,
        priority: 10,
        field: "descriptionNormalized",
        operator: "contains",
        value: "SALARY",
        category: "Income",
        subcategory: "   "
      }
    ]);

    expect(saved[0]?.subcategory).toBeUndefined();
    const persisted = JSON.parse(
      await readFile(join(root, "rules.json"), "utf8")
    ) as { rules: Array<Record<string, unknown>> };
    expect(Object.hasOwn(persisted.rules[0] ?? {}, "subcategory")).toBe(false);
  });
});
