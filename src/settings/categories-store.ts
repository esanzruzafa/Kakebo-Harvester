import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";
import { writeJsonAtomically } from "./atomic-json-file.js";

export const categoryDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subcategories: z.array(z.string().trim().min(1).max(120)).max(200)
});

export type CategoryDefinition = z.output<typeof categoryDefinitionSchema>;

export function validateCategories(value: unknown): CategoryDefinition[] {
  const categories = z.array(categoryDefinitionSchema).max(200).parse(value);
  const names = new Set<string>();
  for (const category of categories) {
    const normalizedName = category.name.toLocaleLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`Category "${category.name}" is duplicated.`);
    }
    names.add(normalizedName);
    const subcategories = new Set<string>();
    for (const subcategory of category.subcategories) {
      const normalizedSubcategory = subcategory.toLocaleLowerCase();
      if (subcategories.has(normalizedSubcategory)) {
        throw new Error(
          `Subcategory "${subcategory}" is duplicated in "${category.name}".`
        );
      }
      subcategories.add(normalizedSubcategory);
    }
  }
  return categories;
}

export class CategoriesStore {
  public constructor(private readonly path: string) {}

  public async load(): Promise<CategoryDefinition[]> {
    try {
      return validateCategories(
        JSON.parse(await readFile(this.path, "utf8")) as unknown
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ConfigurationError("The categories file is not valid.", {
        cause: error
      });
    }
  }

  public async save(input: unknown): Promise<CategoryDefinition[]> {
    let categories: CategoryDefinition[];
    try {
      categories = validateCategories(input);
    } catch (error) {
      throw new ConfigurationError("The category dependencies are not valid.", {
        cause: error
      });
    }
    await writeJsonAtomically(this.path, categories, { backup: true });
    return categories;
  }
}
