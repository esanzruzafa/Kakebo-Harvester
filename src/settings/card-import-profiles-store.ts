import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";
import { writeJsonAtomically } from "./atomic-json-file.js";

function excelColumnIndex(reference: string): number {
  let result = 0;
  for (const character of reference) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

const excelColumnSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z]{1,3}$/u)
      .refine((value) => excelColumnIndex(value) < 16_384, {
        message: "The column must be between A and XFD."
      })
  );

export const cardImportProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u),
    enabled: z.boolean(),
    name: z.string().trim().min(1).max(120),
    bankName: z.string().trim().min(1).max(120),
    cardName: z.string().trim().min(1).max(120),
    sheet: z.string().trim().max(120),
    startRow: z.number().int().min(1).max(1_048_576),
    columns: z.object({
      date: excelColumnSchema,
      description: excelColumnSchema,
      valueDate: excelColumnSchema.nullable(),
      amount: excelColumnSchema
    }),
    dateFormat: z.enum(["auto", "dmy", "ymd", "mdy"]),
    decimalSeparator: z.enum(["auto", ".", ","]),
    invertAmountSign: z.boolean(),
    currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/u))
  })
  .superRefine((profile, context) => {
    const seen = new Map<string, string>();
    for (const [field, column] of Object.entries(profile.columns)) {
      if (column === null) continue;
      const previous = seen.get(column);
      if (previous) {
        context.addIssue({
          code: "custom",
          message: `Column ${column} is already mapped to ${previous}.`,
          path: ["columns", field]
        });
      } else {
        seen.set(column, field);
      }
    }
  });

export type CardImportProfile = z.output<typeof cardImportProfileSchema>;

const profilesSchema = z
  .array(cardImportProfileSchema)
  .min(1)
  .max(100)
  .superRefine((profiles, context) => {
    const ids = new Set<string>();
    for (const [index, profile] of profiles.entries()) {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: "custom",
          message: `Card profile id "${profile.id}" is duplicated.`,
          path: [index, "id"]
        });
      }
      ids.add(profile.id);
    }
  });

export function createDefaultCardImportProfiles(): CardImportProfile[] {
  return [
    {
      id: "kutxabank-card-1",
      enabled: true,
      name: "Kutxabank card 1",
      bankName: "Kutxabank",
      cardName: "Kutxabank card 1",
      sheet: "",
      startRow: 9,
      columns: {
        date: "A",
        description: "B",
        valueDate: "C",
        amount: "D"
      },
      dateFormat: "dmy",
      decimalSeparator: ",",
      invertAmountSign: false,
      currency: "EUR"
    }
  ];
}

export class CardImportProfilesStore {
  public constructor(
    private readonly path: string,
    private readonly defaults = createDefaultCardImportProfiles()
  ) {}

  public async load(): Promise<CardImportProfile[]> {
    try {
      return profilesSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")) as unknown
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(this.defaults);
      }
      throw new ConfigurationError("The card import profiles file is not valid.", {
        cause: error
      });
    }
  }

  public async ensure(): Promise<CardImportProfile[]> {
    try {
      await readFile(this.path, "utf8");
      return await this.load();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return await this.save(this.defaults);
    }
  }

  public async save(input: unknown): Promise<CardImportProfile[]> {
    let profiles: CardImportProfile[];
    try {
      profiles = profilesSchema.parse(input);
    } catch (error) {
      throw new ConfigurationError("The card import profiles are not valid.", {
        cause: error
      });
    }
    await writeJsonAtomically(this.path, profiles, { backup: true });
    return profiles;
  }
}
