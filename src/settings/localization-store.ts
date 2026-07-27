import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../errors.js";

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
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${process.pid}.${Date.now()}.tmp`;
    const backup = `${this.settingsPath}.backup`;
    try {
      await copyFile(this.settingsPath, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          language: this.language,
          auditHistoryLimit: this.auditHistoryLimit
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temporary, this.settingsPath);
  }

  public async setLanguage(language: AppLanguage): Promise<void> {
    this.language = language;
    this.translations = await this.loadLanguageFile(language);
    await this.writeSettings();
  }

  public getLanguage(): AppLanguage {
    return this.language;
  }

  public async setAuditHistoryLimit(limit: AuditHistoryLimit): Promise<void> {
    this.auditHistoryLimit = limit;
    await this.writeSettings();
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
