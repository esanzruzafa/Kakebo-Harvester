import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { createPortablePackage } from "../../scripts/create-portable-package.mjs";

const publicSources = [
  "LICENSE",
  "docs/PORTABLE_PACKAGE.md",
  "docs/PORTABLE_PRIVATE.md",
  "private/.env.production.example",
  "config/accounts.example.json",
  "config/card-import-profiles.example.json",
  "config/categories.example.json",
  "config/categorization-rules.example.json",
  "config/export-settings.example.json",
  "config/ui-settings.example.json",
  "data/production/raw/.gitkeep",
  "data/production/exports/.gitkeep",
  "release/portable/Kakebo-Harvester-1.0.0-x64.exe"
];

describe("portable complete package", () => {
  let root;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("creates an allowlisted starter ZIP without private runtime files", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-complete-package-"));
    for (const source of publicSources) {
      const path = join(root, source);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        source === "private/.env.production.example"
          ? "ENABLE_BANKING_APPLICATION_ID=\nSESSION_ENCRYPTION_KEY=\n"
          : `public:${source}`
      );
    }
    await writeFile(join(root, "private/.env.production"), "REAL_SECRET=value");

    const result = await createPortablePackage(root, "1.0.0");
    const archive = unzipSync(new Uint8Array(await readFile(result.path)));
    const entries = Object.keys(archive).sort();

    expect(result.path).toBe(
      join(
        root,
        "release/portable/Kakebo-Harvester-1.0.0-x64-complete-package.zip"
      )
    );
    expect(entries).toEqual([
      "Kakebo-Harvester-1.0.0-x64/LICENSE",
      "Kakebo-Harvester-1.0.0-x64/README-PORTABLE.md",
      "Kakebo-Harvester-1.0.0-x64/config/accounts.example.json",
      "Kakebo-Harvester-1.0.0-x64/config/card-import-profiles.example.json",
      "Kakebo-Harvester-1.0.0-x64/config/categories.example.json",
      "Kakebo-Harvester-1.0.0-x64/config/categorization-rules.example.json",
      "Kakebo-Harvester-1.0.0-x64/config/export-settings.example.json",
      "Kakebo-Harvester-1.0.0-x64/config/ui-settings.example.json",
      "Kakebo-Harvester-1.0.0-x64/data/production/exports/.gitkeep",
      "Kakebo-Harvester-1.0.0-x64/data/production/raw/.gitkeep",
      "Kakebo-Harvester-1.0.0-x64/Kakebo-Harvester-1.0.0-x64.exe",
      "Kakebo-Harvester-1.0.0-x64/private/.env.production.example",
      "Kakebo-Harvester-1.0.0-x64/private/README.md"
    ].sort());
    expect(entries.some((entry) => entry.endsWith("/.env.production"))).toBe(
      false
    );
    expect(
      new TextDecoder().decode(
        archive[
          "Kakebo-Harvester-1.0.0-x64/Kakebo-Harvester-1.0.0-x64.exe"
        ]
      )
    ).toBe(
      "public:release/portable/Kakebo-Harvester-1.0.0-x64.exe"
    );
  });

  it("fails instead of publishing an incomplete package", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-incomplete-package-"));

    await expect(createPortablePackage(root, "1.0.0")).rejects.toThrow(
      /required package file/u
    );
  });

  it("rejects a production example that was filled with private values", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-secret-package-"));
    for (const source of publicSources) {
      const path = join(root, source);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        source === "private/.env.production.example"
          ? "ENABLE_BANKING_APPLICATION_ID=private-app\nSESSION_ENCRYPTION_KEY=private-key\n"
          : `public:${source}`
      );
    }

    await expect(createPortablePackage(root, "1.0.0")).rejects.toThrow(
      /environment example contains/u
    );
  });
});
