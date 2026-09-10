import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";
import { writeJsonAtomically } from "./atomic-json-file.js";

export type AppLanguage = "en" | "es";
export type TranslationDictionary = Record<string, string>;

const uiSettingsSchema = z.object({
  language: z.enum(["en", "es"]),
  auditHistoryLimit: z.union([
    z.literal(5),
    z.literal(10),
    z.literal(20),
    z.literal(50),
    z.literal(100)
  ]).default(10)
});

export type AuditHistoryLimit = 5 | 10 | 20 | 50 | 100;

function parseDictionary(value: unknown): TranslationDictionary {
  return z.record(z.string(), z.string()).parse(value);
}

export class LocalizationStore {
  private language: AppLanguage;
  private auditHistoryLimit: AuditHistoryLimit = 10;
  private translations: TranslationDictionary = {};
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly settingsPath: string,
    private readonly localesDirectory: string,
    systemLocale: string
  ) {
    this.language = systemLocale.toLowerCase().startsWith("es") ? "es" : "en";
  }

  private async loadLanguageFile(
    language: AppLanguage
  ): Promise<TranslationDictionary> {
    try {
      return parseDictionary(
        JSON.parse(
          await readFile(join(this.localesDirectory, `${language}.json`), "utf8")
        ) as unknown
      );
    } catch (error) {
      throw new ConfigurationError(
        `The ${language} translation file is not valid.`,
        { cause: error }
      );
    }
  }

  public async initialize(): Promise<void> {
    try {
      const settings = uiSettingsSchema.parse(
        JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown
      );
      this.language = settings.language;
      this.auditHistoryLimit = settings.auditHistoryLimit;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigurationError("The UI settings file is not valid.", {
          cause: error
        });
      }
      await this.writeSettings();
    }
    this.translations = await this.loadLanguageFile(this.language);
  }

  private async writeSettings(): Promise<void> {
    await writeJsonAtomically(
      this.settingsPath,
      {
        language: this.language,
        auditHistoryLimit: this.auditHistoryLimit
      },
      { backup: true }
    );
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutationQueue.then(operation);
    this.mutationQueue = pending.catch(() => undefined);
    return pending;
  }

  public async setLanguage(language: AppLanguage): Promise<void> {
    await this.enqueueMutation(async () => {
      const previousLanguage = this.language;
      const previousTranslations = this.translations;
      const translations = await this.loadLanguageFile(language);
      this.language = language;
      this.translations = translations;
      try {
        await this.writeSettings();
      } catch (error) {
        this.language = previousLanguage;
        this.translations = previousTranslations;
        throw error;
      }
    });
  }

  public getLanguage(): AppLanguage {
    return this.language;
  }

  public async setAuditHistoryLimit(limit: AuditHistoryLimit): Promise<void> {
    await this.enqueueMutation(async () => {
      const previous = this.auditHistoryLimit;
      this.auditHistoryLimit = limit;
      try {
        await this.writeSettings();
      } catch (error) {
        this.auditHistoryLimit = previous;
        throw error;
      }
    });
  }

  public getAuditHistoryLimit(): AuditHistoryLimit {
    return this.auditHistoryLimit;
  }

  public getTranslations(): TranslationDictionary {
    return { ...this.translations };
  }

  public translate(key: string, fallback: string): string {
    return this.translations[key] ?? fallback;
  }
}
