import {
  CategorizationRulesStore,
  type CategorizationRule
} from "../settings/categorization-rules-store.js";
import { normalizeText } from "../utils/text.js";

export class Categorizer {
  private rules: CategorizationRule[] = [];
  private readonly store: CategorizationRulesStore;

  public constructor(path = "config/categorization-rules.json") {
    this.store = new CategorizationRulesStore(path);
    this.reload();
  }

  public reload(): void {
    this.rules = this.store.loadSync();
  }

  public categorize(descriptionNormalized: string): {
    category: string | null;
    subcategory: string | null;
  } {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const value = normalizeText(rule.value);
      const matches =
        rule.operator === "contains"
          ? descriptionNormalized.includes(value)
          : rule.operator === "equals"
            ? descriptionNormalized === value
            : rule.operator === "startsWith"
              ? descriptionNormalized.startsWith(value)
              : new RegExp(rule.value, "iu").test(descriptionNormalized);
      if (matches) {
        return {
          category: rule.category,
          subcategory: rule.subcategory ?? null
        };
      }
    }
    return { category: null, subcategory: null };
  }
}
