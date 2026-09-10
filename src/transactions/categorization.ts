import {
  CategorizationRulesStore,
  type CategorizationExclusion,
  type CategorizationRule
} from "../settings/categorization-rules-store.js";
import { normalizeText } from "../utils/text.js";

const compiledRegexes = new WeakMap<object, RegExp>();

export class Categorizer {
  private rules: CategorizationRule[] = [];
  private exclusions: CategorizationExclusion[] = [];
  private readonly store: CategorizationRulesStore;

  public constructor(path = "config/categorization-rules.json") {
    this.store = new CategorizationRulesStore(path);
    this.reload();
  }

  public reload(): void {
    const configuration = this.store.loadConfigurationSync();
    this.rules = configuration.rules;
    this.exclusions = configuration.exclusions;
  }

  public categorize(descriptionNormalized: string): {
    category: string | null;
    subcategory: string | null;
  } {
    if (this.exclusions.some((exclusion) => matches(exclusion, descriptionNormalized))) {
      return { category: null, subcategory: null };
    }
    for (const rule of this.rules) {
      if (matches(rule, descriptionNormalized)) {
        return {
          category: rule.category,
          subcategory: rule.subcategory ?? null
        };
      }
    }
    return { category: null, subcategory: null };
  }
}

function matches(
  rule: CategorizationRule | CategorizationExclusion,
  descriptionNormalized: string
): boolean {
  if (!rule.enabled) return false;
  const value = normalizeText(rule.value);
  return rule.operator === "contains"
    ? descriptionNormalized.includes(value)
    : rule.operator === "equals"
      ? descriptionNormalized === value
      : rule.operator === "startsWith"
        ? descriptionNormalized.startsWith(value)
        : regexFor(rule).test(descriptionNormalized);
}

function regexFor(
  rule: CategorizationRule | CategorizationExclusion
): RegExp {
  const cached = compiledRegexes.get(rule);
  if (cached) return cached;
  const compiled = new RegExp(rule.value, "iu");
  compiledRegexes.set(rule, compiled);
  return compiled;
}
