import { readFileSync } from "node:fs";
import { z } from "zod";
import { normalizeText } from "../utils/text.js";

const ruleSchema = z.object({
  priority: z.number().int(),
  field: z.literal("descriptionNormalized"),
  operator: z.enum(["contains", "equals", "startsWith", "regex"]),
  value: z.string().min(1),
  category: z.string().min(1),
  subcategory: z.string().optional()
});

type Rule = z.infer<typeof ruleSchema>;

export class Categorizer {
  private readonly rules: Rule[];

  public constructor(path = "config/categorization-rules.json") {
    try {
      this.rules = z
        .array(ruleSchema)
        .parse(JSON.parse(readFileSync(path, "utf8")))
        .sort((left, right) => left.priority - right.priority);
    } catch {
      this.rules = [];
    }
  }

  public categorize(descriptionNormalized: string): {
    category: string | null;
    subcategory: string | null;
  } {
    for (const rule of this.rules) {
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
