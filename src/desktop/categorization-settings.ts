import {
  validateCategories,
  type CategoriesStore,
  type CategoryDefinition
} from "../settings/categories-store.js";
import {
  validateCategorizationConfiguration,
  type CategorizationConfiguration,
  type CategorizationRulesStore
} from "../settings/categorization-rules-store.js";

export class CategorizationReferenceError extends Error {
  public constructor(
    public readonly ruleNumber: number,
    public readonly category: string,
    public readonly subcategory?: string
  ) {
    super(
      subcategory
        ? `Rule ${ruleNumber} uses a subcategory that does not belong to "${category}".`
        : `Rule ${ruleNumber} uses an unknown category: "${category}".`
    );
    this.name = "CategorizationReferenceError";
  }
}

export interface CategorizationSettings {
  categories: CategoryDefinition[];
  exclusions: CategorizationConfiguration["exclusions"];
  rules: CategorizationConfiguration["rules"];
}

export async function saveCategorizationSettings(
  categoriesStore: Pick<CategoriesStore, "load" | "save">,
  rulesStore: Pick<
    CategorizationRulesStore,
    "loadConfiguration" | "saveConfiguration"
  >,
  input: unknown
): Promise<CategorizationSettings> {
  const parsed = input as Partial<CategorizationSettings>;
  const categories = validateCategories(parsed.categories);
  const configuration = validateCategorizationConfiguration({
    exclusions: parsed.exclusions,
    rules: parsed.rules
  });
  for (const [index, rule] of configuration.rules.entries()) {
    const category = categories.find((item) => item.name === rule.category);
    if (!category) {
      throw new CategorizationReferenceError(index + 1, rule.category);
    }
    if (rule.subcategory && !category.subcategories.includes(rule.subcategory)) {
      throw new CategorizationReferenceError(
        index + 1,
        rule.category,
        rule.subcategory
      );
    }
  }

  const previousCategories = await categoriesStore.load();
  const previousConfiguration = await rulesStore.loadConfiguration();
  try {
    const savedCategories = await categoriesStore.save(categories);
    const savedConfiguration = await rulesStore.saveConfiguration(configuration);
    return { categories: savedCategories, ...savedConfiguration };
  } catch (error) {
    const rollback = await Promise.allSettled([
      categoriesStore.save(previousCategories),
      rulesStore.saveConfiguration(previousConfiguration)
    ]);
    const rollbackErrors: unknown[] = [];
    for (const result of rollback) {
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        rollbackErrors.push(reason);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Categorization settings could not be saved or fully rolled back.",
        { cause: error }
      );
    }
    throw error;
  }
}
