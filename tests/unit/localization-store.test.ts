import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalizationStore } from "../../src/settings/localization-store.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function initializedStore(): Promise<{
  store: LocalizationStore;
  settingsDirectory: string;
}> {
  root = await mkdtemp(join(tmpdir(), "kakebo-localization-"));
  const localesDirectory = join(root, "locales");
  const settingsDirectory = join(root, "settings");
  const settingsPath = join(settingsDirectory, "ui.json");
  await mkdir(localesDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(localesDirectory, "en.json"), '{"label":"English"}\n'),
    writeFile(join(localesDirectory, "es.json"), '{"label":"Español"}\n')
  ]);
  const store = new LocalizationStore(settingsPath, localesDirectory, "en-US");
  await store.initialize();
  return { store, settingsDirectory };
}

async function blockSettingsDirectory(settingsDirectory: string): Promise<void> {
  await rm(settingsDirectory, { recursive: true, force: true });
  await writeFile(settingsDirectory, "not a directory");
}

describe("localization settings durability", () => {
  it("serializes concurrent language and audit-limit changes without losing either value", async () => {
    const { store, settingsDirectory } = await initializedStore();

    await Promise.all([
      store.setLanguage("es"),
      store.setAuditHistoryLimit(50)
    ]);

    const persisted = JSON.parse(
      await readFile(join(settingsDirectory, "ui.json"), "utf8")
    ) as unknown;
    expect(persisted).toEqual({ language: "es", auditHistoryLimit: 50 });
    expect(store.getLanguage()).toBe("es");
    expect(store.getAuditHistoryLimit()).toBe(50);
  });

  it("restores the active language when persistence fails", async () => {
    const { store, settingsDirectory } = await initializedStore();
    await blockSettingsDirectory(settingsDirectory);

    await expect(store.setLanguage("es")).rejects.toThrow();
    expect(store.getLanguage()).toBe("en");
    expect(store.translate("label", "fallback")).toBe("English");
  });

  it("restores the audit limit when persistence fails", async () => {
    const { store, settingsDirectory } = await initializedStore();
    await blockSettingsDirectory(settingsDirectory);

    await expect(store.setAuditHistoryLimit(50)).rejects.toThrow();
    expect(store.getAuditHistoryLimit()).toBe(10);
  });
});
