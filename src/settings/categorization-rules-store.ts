import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";

export const categorizationOperatorSchema = z.enum([
  "contains",
  "equals",
  "startsWith",
  "regex"
]);

const baseRuleSchema = z.object({
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0),
  field: z.literal("descriptionNormalized"),
  operator: categorizationOperatorSchema,
  value: z.string().trim().min(1).max(500)
});

export const categorizationExclusionSchema = baseRuleSchema;

export const categorizationRuleSchema = baseRuleSchema.extend({
  category: z.string().trim().min(1).max(120),
  subcategory: z.string().trim().max(120).optional()
});

export type CategorizationRule = z.output<typeof categorizationRuleSchema>;
export type CategorizationExclusion = z.output<
  typeof categorizationExclusionSchema
>;

export interface CategorizationConfiguration {
  exclusions: CategorizationExclusion[];
  rules: CategorizationRule[];
}

function validateAndSort<T extends { priority: number; operator: string; value: string }>(
  values: T[]
): T[] {
  const priorities = new Set<number>();
  for (const value of values) {
    if (priorities.has(value.priority)) {
      throw new Error(`Priority ${value.priority} is duplicated.`);
    }
    priorities.add(value.priority);
    if (value.operator === "regex") {
      new RegExp(value.value, "iu");
    }
  }
  return values.sort((left, right) => left.priority - right.priority);
}

function parseConfiguration(value: unknown): CategorizationConfiguration {
  if (Array.isArray(value)) {
    return {
      exclusions: [],
      rules: validateAndSort(z.array(categorizationRuleSchema).parse(value))
    };
  }
  const parsed = z
    .object({
      exclusions: z.array(categorizationExclusionSchema).default([]),
      rules: z.array(categorizationRuleSchema).default([])
    })
    .parse(value);
  return {
    exclusions: validateAndSort(parsed.exclusions),
    rules: validateAndSort(parsed.rules)
  };
}

export class CategorizationRulesStore {
  public constructor(private readonly path: string) {}

  public async loadConfiguration(): Promise<CategorizationConfiguration> {
    try {
      return parseConfiguration(
        JSON.parse(await readFile(this.path, "utf8")) as unknown
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exclusions: [], rules: [] };
      }
      throw new ConfigurationError("The categorization rules file is not valid.", {
        cause: error
      });
    }
  }

  public loadConfigurationSync(): CategorizationConfiguration {
    try {
      return parseConfiguration(
        JSON.parse(readFileSync(this.path, "utf8")) as unknown
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exclusions: [], rules: [] };
      }
      throw new ConfigurationError("The categorization rules file is not valid.", {
        cause: error
      });
    }
  }

  public async load(): Promise<CategorizationRule[]> {
    return (await this.loadConfiguration()).rules;
  }

  public loadSync(): CategorizationRule[] {
    return this.loadConfigurationSync().rules;
  }

  public async saveConfiguration(
    input: unknown
  ): Promise<CategorizationConfiguration> {
    let configuration: CategorizationConfiguration;
    try {
      configuration = parseConfiguration(input);
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
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
    return configuration;
  }

  public async save(input: unknown): Promise<CategorizationRule[]> {
    const current = await this.loadConfiguration();
    return (
      await this.saveConfiguration({
        exclusions: current.exclusions,
        rules: input
      })
    ).rules;
  }
}
