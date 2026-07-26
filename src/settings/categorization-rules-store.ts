import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";

export const categorizationRuleSchema = z.object({
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0),
  field: z.literal("descriptionNormalized"),
  operator: z.enum(["contains", "equals", "startsWith", "regex"]),
  value: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(120),
  subcategory: z.string().trim().max(120).optional()
});

export type CategorizationRule = z.output<typeof categorizationRuleSchema>;

function parseRules(value: unknown): CategorizationRule[] {
  const rules = z.array(categorizationRuleSchema).parse(value);
  const priorities = new Set<number>();
  for (const rule of rules) {
    if (priorities.has(rule.priority)) {
      throw new Error(`Priority ${rule.priority} is duplicated.`);
    }
    priorities.add(rule.priority);
    if (rule.operator === "regex") {
      new RegExp(rule.value, "iu");
    }
  }
  return rules.sort((left, right) => left.priority - right.priority);
}

export class CategorizationRulesStore {
  public constructor(private readonly path: string) {}

  public async load(): Promise<CategorizationRule[]> {
    try {
      return parseRules(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ConfigurationError("The categorization rules file is not valid.", {
        cause: error
      });
    }
  }

  public loadSync(): CategorizationRule[] {
    try {
      return parseRules(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ConfigurationError("The categorization rules file is not valid.", {
        cause: error
      });
    }
  }

  public async save(input: unknown): Promise<CategorizationRule[]> {
    let rules: CategorizationRule[];
    try {
      rules = parseRules(input);
    } catch (error) {
      throw new ConfigurationError("The categorization rules are not valid.", {
        cause: error
      });
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const backup = `${this.path}.backup`;
    try {
      await copyFile(this.path, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(temporary, `${JSON.stringify(rules, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
    return rules;
  }
}
