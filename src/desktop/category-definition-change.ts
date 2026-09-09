import type { CategoryDefinition } from "../settings/categories-store.js";
import type { CategorizationRule } from "../settings/categorization-rules-store.js";

export interface CategoryDefinitionChange {
  categories: CategoryDefinition[];
  rules: CategorizationRule[];
  index: number;
  replacement: CategoryDefinition;
}

export function applyCategoryDefinitionChange({
  categories,
  rules,
  index,
  replacement
}: CategoryDefinitionChange): Pick<CategoryDefinitionChange, "categories" | "rules"> {
  const previous = categories[index];
  if (!previous) return { categories, rules };
  const nextCategories = categories.map((category, categoryIndex) =>
    categoryIndex === index ? replacement : category
  );
  const allowedSubcategories = new Set(replacement.subcategories);
  return {
    categories: nextCategories,
    rules: rules.map((rule) => {
      if (rule.category !== previous.name) return rule;
      const subcategory =
        rule.subcategory && allowedSubcategories.has(rule.subcategory)
          ? rule.subcategory
          : undefined;
      return {
        ...rule,
        category: replacement.name,
        ...(subcategory ? { subcategory } : { subcategory: undefined })
      };
    })
  };
}

export function removeCategoryDefinition({
  categories,
  rules,
  index
}: Omit<CategoryDefinitionChange, "replacement">): Pick<
  CategoryDefinitionChange,
  "categories" | "rules"
> {
  const removed = categories[index];
  if (!removed) return { categories, rules };
  return {
    categories: categories.filter((_category, categoryIndex) => categoryIndex !== index),
    rules: rules.map((rule) => {
      if (rule.category !== removed.name) return rule;
      const replacement = { ...rule, category: "" };
      delete replacement.subcategory;
      return replacement;
    })
  };
}
