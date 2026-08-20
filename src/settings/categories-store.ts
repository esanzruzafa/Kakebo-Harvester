import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";

export const categoryDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subcategories: z.array(z.string().trim().min(1).max(120)).max(200)
});

export type CategoryDefinition = z.output<typeof categoryDefinitionSchema>;

function parseCategories(value: unknown): CategoryDefinition[] {
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
      return parseCategories(
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
      categories = parseCategories(input);
    } catch (error) {
      throw new ConfigurationError("The category dependencies are not valid.", {
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
    await writeFile(temporary, `${JSON.stringify(categories, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
    return categories;
  }
}
